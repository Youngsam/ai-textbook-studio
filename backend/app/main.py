import asyncio
import base64
import hashlib
import json
import logging
import shutil
import sqlite3
import time
from contextlib import aclosing, asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from uuid import UUID, uuid4

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import APIStatusError, AuthenticationError, RateLimitError
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.backup import (
    INTERVAL_SECONDS,
    RETAIN_COUNT,
    create_backup,
    current_fingerprint,
    destination,
    prune_backups,
)
from app.config import ROOT, Settings
from app.db import make_engine, migrate, sessions
from app.llm import INSTRUCTIONS, ChatContext, make_adapter
from app.models import AppSettings, Book, ChatRequest, Message, ReadingState, Thread, now
from app.pdf import PdfService
from app.schemas import BackupPreferences, ModelSelection, Preferences, Question, ReaderState

logger = logging.getLogger("studio")
ACTIVE = ("pending", "streaming")


def fail(status, code, message):
    raise HTTPException(status, {"code": code, "message": message})


class RequestGuard:
    """Count multipart bytes before Starlette spools them to disk."""

    def __init__(self, app, settings):
        self.app, self.settings = app, settings

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        origin = headers.get(b"origin", b"").decode()
        host = headers.get(b"host", b"").decode()
        allowed = self.settings.allowed_origins.split(",")
        if origin and origin not in allowed and origin != f"{scope['scheme']}://{host}":
            return await JSONResponse({"detail": "허용되지 않은 Origin입니다."}, 403)(
                scope, receive, send
            )
        total = 0
        limit = self.settings.max_upload_bytes + 1024 * 1024
        if scope["method"] == "POST" and scope["path"] == "/api/books":
            try:
                size = int(headers.get(b"content-length", b"0"))
            except ValueError:
                size = 0
            if size > limit:
                return await JSONResponse({"detail": "업로드 크기 제한을 초과했습니다."}, 413)(
                    scope, receive, send
                )

            async def bounded_receive():
                nonlocal total
                message = await receive()
                total += len(message.get("body", b""))
                if total > limit:
                    raise HTTPException(413, "업로드 크기 제한을 초과했습니다.")
                return message

            return await self.app(scope, bounded_receive, send)
        return await self.app(scope, receive, send)


def create_app(settings: Settings | None = None, adapter=None):
    settings = settings or Settings()
    engine = make_engine(settings)
    Session = sessions(engine)
    pdf = PdfService(settings.pdf_process_timeout_seconds)
    backup_lock = Lock()

    def folder(book_id):
        return settings.data_dir / "books" / str(UUID(str(book_id)))

    def get_book(session, book_id, deleting=False):
        book = session.get(Book, str(book_id))
        if book is None:
            fail(404, "book_not_found", "책을 찾을 수 없습니다.")
        if book.status != "ready" and not deleting:
            fail(409, "book_deleting", "삭제 중인 책입니다. 삭제를 다시 시도해 주세요.")
        return book

    def summary(session, book):
        state = session.get(ReadingState, book.id)
        return {
            "id": book.id,
            "title": book.title,
            "author": book.author,
            "page_count": book.page_count,
            "current_page": state.page,
            "progress": round(state.page / book.page_count * 100),
            "status": book.status,
            "created_at": book.created_at,
            "last_opened_at": book.last_opened_at,
        }

    @asynccontextmanager
    async def lifespan(app):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        database_path = Path(settings.database_url.removeprefix("sqlite:///"))
        database_path.parent.mkdir(parents=True, exist_ok=True)
        (settings.data_dir / "books").mkdir(exist_ok=True)
        temporary = settings.data_dir / "tmp"
        temporary.mkdir(exist_ok=True)
        migrate(engine)
        with Session.begin() as session:
            session.execute(
                update(ChatRequest)
                .where(ChatRequest.status.in_(ACTIVE))
                .values(status="interrupted", error_code="server_restarted", finished_at=now())
            )
            session.execute(
                update(Message)
                .where(Message.status.in_(ACTIVE))
                .values(status="interrupted", error_code="server_restarted")
            )
            prefs = session.get(AppSettings, 1)
            if prefs is None:
                prefs = AppSettings(id=1)
                session.add(prefs)
            if not (prefs.backup_state or {}).get("source_id"):
                prefs.backup_state = {**(prefs.backup_state or {}), "source_id": str(uuid4())}
            known = set(session.scalars(select(Book.id)))
        for item in temporary.glob("*.upload"):
            item.unlink(missing_ok=True)
        # Only remove UUID directories created by this application.
        for item in (settings.data_dir / "books").iterdir():
            with suppress(ValueError):
                UUID(item.name)
                if item.is_dir() and item.name not in known:
                    shutil.rmtree(item)
        app.state.Session = Session
        app.state.settings = settings
        app.state.run_backup = run_backup
        stop_backups = asyncio.Event()

        async def automatic_backups():
            while not stop_backups.is_set():
                try:
                    await asyncio.wait_for(stop_backups.wait(), timeout=min(60, INTERVAL_SECONDS))
                except TimeoutError:
                    pass
                if stop_backups.is_set():
                    break
                try:
                    await asyncio.to_thread(run_backup, automatic=True)
                except Exception:
                    # Status is persisted by run_backup; keep the worker alive for retries.
                    logger.warning("Automatic backup did not complete; will retry next interval")

        task = asyncio.create_task(automatic_backups())
        try:
            yield
        finally:
            # Await any in-flight snapshot instead of abandoning its worker thread.
            stop_backups.set()
            await task
            engine.dispose()

    app = FastAPI(title="AI Textbook Studio", lifespan=lifespan)
    app.add_middleware(RequestGuard, settings=settings)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts.split(","))

    @app.get("/api/health")
    def health():
        with Session() as session:
            session.execute(text("SELECT 1"))
        return {"status": "ok", "database": "ready"}

    @app.get("/api/settings")
    def read_settings():
        with Session() as session:
            prefs = session.get(AppSettings, 1)
            provider = prefs.provider or settings.llm_provider
            model = prefs.model or settings.llm_model
            return {
                "provider": provider,
                "model": model,
                "available_models": settings.available_models,
                "llm_configured": provider == "fake"
                or bool(settings.api_key_for(provider) and model),
                "supports_images": settings.llm_supports_images,
                "response_style": prefs.response_style,
                "image_mode": prefs.image_mode,
                "max_upload_bytes": settings.max_upload_bytes,
            }

    @app.get("/api/settings/backup")
    def read_backup_settings():
        with Session() as session:
            prefs = session.get(AppSettings, 1)
            state = prefs.backup_state
            return {
                "path": prefs.backup_path,
                "auto_enabled": prefs.backup_auto,
                "interval_minutes": INTERVAL_SECONDS // 60,
                "retain_count": RETAIN_COUNT,
                "last_success_at": state.get("last_success_at"),
                "last_path": state.get("last_path"),
                "error": state.get("error"),
                "last_checked_at": state.get("last_checked_at"),
            }

    @app.put("/api/settings/backup")
    def save_backup_settings(body: BackupPreferences):
        try:
            target = destination(body.path, settings)
        except (ValueError, OSError, RuntimeError) as error:
            fail(422, "invalid_backup_path", str(error))
        # Serialize configuration changes with snapshots and retention in the old directory.
        with backup_lock, Session.begin() as session:
            prefs = session.get(AppSettings, 1)
            if prefs.backup_path != str(target) or prefs.backup_auto != body.auto_enabled:
                prefs.backup_state = {
                    **prefs.backup_state,
                    "fingerprint": None,
                    "last_checked_at": None,
                    "error": None,
                }
            prefs.backup_path = str(target)
            prefs.backup_auto = body.auto_enabled
        return read_backup_settings()

    def run_backup(automatic=False, checked_at=None):
        if not backup_lock.acquire(blocking=False):
            if automatic:
                return None
            fail(
                409, "backup_busy", "백업 또는 책 삭제가 진행 중입니다. 잠시 후 다시 시도해 주세요."
            )

        def record(**changes):
            with Session.begin() as session:
                prefs = session.get(AppSettings, 1)
                prefs.backup_state = {**prefs.backup_state, **changes}

        try:
            with Session() as session:
                prefs = session.get(AppSettings, 1)
                value, enabled, state = prefs.backup_path, prefs.backup_auto, prefs.backup_state
            checked_at = checked_at or datetime.now(timezone.utc)
            if automatic:
                if not enabled or not value:
                    return None
                previous = state.get("last_checked_at")
                if (
                    previous
                    and (checked_at - datetime.fromisoformat(previous)).total_seconds()
                    < INTERVAL_SECONDS
                ):
                    return None
            record(last_checked_at=checked_at.isoformat())
            target = destination(value, settings)
            if (
                automatic
                and not state.get("error")
                and state.get("fingerprint") == current_fingerprint(engine)
                and state.get("last_path")
                and Path(state["last_path"]).parent == target
                and (Path(state["last_path"]) / "learning.db").is_file()
            ):
                return None
            result = create_backup(engine, settings, target)
            # Advance only to the fingerprint actually captured in the snapshot. Changes
            # made while copying PDFs must remain dirty for the next scheduled backup.
            record(
                last_success_at=now(),
                last_path=result["path"],
                fingerprint=result["fingerprint"],
                error=None,
            )
            try:
                prune_backups(target, state["source_id"])
            except OSError:
                record(
                    error="백업은 완료했지만 오래된 백업 정리에 실패했습니다. 경로 권한을 확인해 주세요."
                )
            return {key: result[key] for key in ("path", "book_count", "created_at")}
        except (ValueError, RuntimeError) as error:
            record(error=str(error))
            fail(422, "backup_invalid", str(error))
        except sqlite3.Error:
            message = "데이터베이스 백업에 실패했습니다. 다음 자동 백업 주기에 재시도합니다."
            record(error=message)
            fail(503, "backup_database_failed", message)
        except OSError:
            message = "백업에 실패했습니다. 경로의 접근 권한·연결·여유 공간과 원본 PDF를 확인해 주세요. 다음 자동 백업 주기에 재시도합니다."
            record(error=message)
            fail(503, "backup_failed", message)
        finally:
            backup_lock.release()

    @app.post("/api/backups", status_code=201)
    def backup():
        return run_backup()

    @app.put("/api/settings")
    def save_settings(body: Preferences):
        with Session.begin() as session:
            prefs = session.get(AppSettings, 1)
            prefs.response_style, prefs.image_mode = body.response_style, body.image_mode
            if body.provider is not None:
                if body.provider == "fake" and settings.llm_provider != "fake":
                    fail(422, "invalid_provider", "테스트 모드는 서버에서만 활성화할 수 있습니다.")
                prefs.provider = body.provider
            if body.model is not None:
                prefs.model = body.model
        return read_settings()

    @app.post("/api/settings/test")
    async def test_model(body: ModelSelection):
        if settings.llm_provider == "fake" or body.provider == "fake":
            fail(422, "invalid_provider", "테스트 모드는 실제 모델 연결을 검사하지 않습니다.")
        if not settings.api_key_for(body.provider):
            fail(422, "missing_api_key", "선택한 제공업체의 API 키를 서버 .env에 설정해 주세요.")
        context = ChatContext("Reply with OK.", [], None, "concise", body.model)
        try:
            # Use the same streaming path as questions, without sending any book content.
            async with asyncio.timeout(min(30, settings.llm_timeout_seconds)):
                async with aclosing(
                    make_adapter(settings, body.provider).stream(context)
                ) as stream:
                    async for event in stream:
                        if event["type"] == "delta" and event["text"].strip():
                            return {
                                "ok": True,
                                "message": "텍스트 응답을 확인했습니다. 이미지 지원 여부는 별도입니다.",
                            }
            fail(502, "empty_response", "모델에서 텍스트 응답을 받지 못했습니다.")
        except AuthenticationError:
            fail(
                422,
                "provider_authentication",
                "API 키 인증에 실패했습니다. 서버 설정을 확인해 주세요.",
            )
        except RateLimitError:
            fail(429, "provider_rate_limit", "API 사용 한도 또는 잔액을 확인해 주세요.")
        except APIStatusError as error:
            if error.status_code in (400, 403, 404):
                fail(
                    422,
                    "model_unavailable",
                    "모델명, 접근 권한 또는 스트리밍 지원 여부를 확인해 주세요.",
                )
            fail(
                502, "provider_failed", "제공업체 요청에 실패했습니다. 잠시 후 다시 시도해 주세요."
            )
        except TimeoutError:
            fail(504, "timeout", "연결 테스트 시간이 초과되었습니다.")
        except HTTPException:
            raise
        except Exception:
            fail(
                502,
                "provider_failed",
                "모델 연결에 실패했습니다. 모델명과 서버 연결을 확인해 주세요.",
            )

    @app.get("/api/books/{book_id}/outline")
    async def book_outline(book_id: UUID):
        with Session() as session:
            get_book(session, book_id)
        try:
            return await pdf.run("outline", folder(book_id) / "original.pdf")
        except (ValueError, TimeoutError):
            fail(422, "outline_failed", "PDF 목차를 불러오지 못했습니다.")

    @app.post("/api/books", status_code=201)
    async def upload_book(file: UploadFile = File(), title: str = Form(), author: str = Form("")):
        title, author = title.strip(), author.strip()
        if not title or len(title) > 300 or len(author) > 300:
            fail(422, "invalid_title", "제목은 1~300자, 저자는 최대 300자로 입력해 주세요.")
        book_id = str(uuid4())
        temporary = settings.data_dir / "tmp" / f"{book_id}.upload"
        digest, size = hashlib.sha256(), 0
        committed = False
        try:
            with temporary.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_upload_bytes:
                        fail(413, "upload_too_large", "PDF 파일 크기 제한을 초과했습니다.")
                    digest.update(chunk)
                    output.write(chunk)
            with temporary.open("rb") as source:
                if b"%PDF-" not in source.read(1024):
                    fail(422, "invalid_pdf", "유효한 PDF 파일이 아닙니다.")
            try:
                metadata = await pdf.run("inspect", temporary)
            except (ValueError, EOFError):
                fail(422, "invalid_pdf", "손상되었거나 암호화된 PDF는 지원하지 않습니다.")
            except TimeoutError:
                fail(422, "pdf_timeout", "PDF 분석 제한 시간을 초과했습니다.")
            if metadata["page_count"] > settings.max_pdf_pages:
                fail(422, "too_many_pages", "PDF 페이지 수 제한을 초과했습니다.")
            folder(book_id).mkdir()
            temporary.replace(folder(book_id) / "original.pdf")
            with Session.begin() as session:
                book = Book(
                    id=book_id,
                    title=title,
                    author=author,
                    pdf_sha256=digest.hexdigest(),
                    page_count=metadata["page_count"],
                )
                session.add(book)
                session.flush()
                session.add_all([ReadingState(book_id=book_id), Thread(book_id=book_id)])
                session.flush()
                result = summary(session, book)
            committed = True
            return result
        finally:
            await file.close()
            temporary.unlink(missing_ok=True)
            if not committed and folder(book_id).exists():
                shutil.rmtree(folder(book_id))

    @app.get("/api/books")
    def list_books(limit: int = Query(50, ge=1, le=100), before: str | None = None):
        with Session() as session:
            query = select(Book).order_by(Book.last_opened_at.desc(), Book.id.desc())
            if before:
                cursor = session.get(Book, before)
                if cursor:
                    query = query.where(
                        (Book.last_opened_at < cursor.last_opened_at)
                        | ((Book.last_opened_at == cursor.last_opened_at) & (Book.id < cursor.id))
                    )
            books = list(session.scalars(query.limit(limit + 1)))
            return {
                "items": [summary(session, b) for b in books[:limit]],
                "next_cursor": books[limit - 1].id if len(books) > limit else None,
            }

    @app.get("/api/books/{book_id}")
    def open_book(book_id: UUID):
        with Session.begin() as session:
            book = get_book(session, book_id)
            book.last_opened_at = now()
            return summary(session, book)

    @app.get("/api/books/{book_id}/pdf")
    def download_pdf(book_id: UUID):
        with Session() as session:
            get_book(session, book_id)
        path = folder(book_id) / "original.pdf"
        if not path.exists():
            fail(404, "pdf_missing", "원본 PDF 파일이 없습니다. 백업을 확인해 주세요.")
        return FileResponse(
            path,
            media_type="application/pdf",
            filename="book.pdf",
            content_disposition_type="inline",
            headers={"Cache-Control": "private"},
        )

    @app.delete("/api/books/{book_id}", status_code=204)
    def delete_book(book_id: UUID):
        with backup_lock:
            # A write transaction serializes deletion with new chat acceptance.
            with Session.begin() as session:
                session.execute(text("BEGIN IMMEDIATE"))
                book = get_book(session, book_id, deleting=True)
                if session.scalar(
                    select(ChatRequest.id).where(
                        ChatRequest.book_id == book.id, ChatRequest.status.in_(ACTIVE)
                    )
                ):
                    fail(409, "chat_active", "답변이 끝난 뒤 삭제해 주세요.")
                book.status = "deleting"
            try:
                if folder(book_id).exists():
                    shutil.rmtree(folder(book_id))
            except OSError:
                fail(503, "delete_failed", "파일 삭제에 실패했습니다. 다시 시도해 주세요.")
            with Session.begin() as session:
                session.delete(get_book(session, book_id, deleting=True))

    @app.get("/api/books/{book_id}/state")
    def read_state(book_id: UUID):
        with Session() as session:
            get_book(session, book_id)
            state = session.get(ReadingState, str(book_id))
            return {
                **ReaderState.model_validate(state).model_dump(),
                "updated_at": state.updated_at,
            }

    @app.put("/api/books/{book_id}/state")
    def save_state(book_id: UUID, body: ReaderState):
        with Session.begin() as session:
            book = get_book(session, book_id)
            if body.page > book.page_count:
                fail(422, "page_out_of_range", "책의 페이지 범위를 벗어났습니다.")
            state = session.get(ReadingState, book.id)
            for key, value in body.model_dump().items():
                setattr(state, key, value)
            state.updated_at = now()
        return {**body.model_dump(), "updated_at": state.updated_at}

    @app.get("/api/books/{book_id}/messages")
    def history(book_id: UUID, limit: int = Query(50, ge=1, le=100), before: str | None = None):
        with Session() as session:
            get_book(session, book_id)
            thread = session.scalar(select(Thread).where(Thread.book_id == str(book_id)))
            query = select(Message).where(Message.thread_id == thread.id)
            if before:
                cursor = session.get(Message, before)
                if not cursor or cursor.thread_id != thread.id:
                    fail(422, "invalid_cursor", "대화 커서가 유효하지 않습니다.")
                query = query.where(
                    (Message.created_at < cursor.created_at)
                    | ((Message.created_at == cursor.created_at) & (Message.id < cursor.id))
                )
            messages = list(
                session.scalars(
                    query.order_by(Message.created_at.desc(), Message.id.desc()).limit(limit + 1)
                )
            )
            items = []
            for message in reversed(messages[:limit]):
                record = {
                    column.name: getattr(message, column.name)
                    for column in Message.__table__.columns
                }
                record["request_id"] = session.get(ChatRequest, message.chat_request_id).request_id
                items.append(record)
            return {
                "items": items,
                "next_cursor": messages[limit - 1].id if len(messages) > limit else None,
            }

    async def build_context(book_id, body):
        with Session() as session:
            book = get_book(session, book_id)
            title = book.title
            thread = session.scalar(select(Thread).where(Thread.book_id == str(book_id)))
            records = list(
                session.scalars(
                    select(Message)
                    .join(ChatRequest, Message.chat_request_id == ChatRequest.id)
                    .where(
                        Message.thread_id == thread.id,
                        Message.status == "completed",
                        ChatRequest.status == "completed",
                    )
                    .order_by(Message.created_at.desc(), Message.id.desc())
                    .limit(12)
                )
            )
        path = folder(book_id) / "original.pdf"
        result = await pdf.run("page", path, body.page)
        page_text = result["text"]
        image = body.image_mode == "always" or (
            body.image_mode == "auto" and len(page_text.strip()) < 50
        )
        if image and not settings.llm_supports_images:
            raise ValueError("images_unsupported")
        if not page_text.strip() and not image:
            raise ValueError("image_required")
        image_url, cache_key = None, None
        if image:
            cache_key = f"page-{body.page}-2048-v1.jpg"
            result = await pdf.run(
                "page", path, body.page, str(folder(book_id) / "images" / cache_key)
            )
            image_bytes = Path(result["image_path"]).read_bytes()
            if len(image_bytes) > 5 * 1024 * 1024:
                raise ValueError("image_too_large")
            image_url = "data:image/jpeg;base64," + base64.b64encode(image_bytes).decode()
        prefix = (
            f"책: {title}\nPDF 페이지: {body.page}\n질문: {body.question}\n"
            f"<selected_text>\n{body.selected_text}\n</selected_text>\n"
        )
        # UTF-8 bytes are a conservative token upper bound, not a tokenizer estimate.
        remaining = settings.llm_input_token_budget - len((INSTRUCTIONS + prefix).encode()) - 256
        if remaining < 0:
            raise ValueError("context_too_large")
        full_page = page_text.encode()
        clipped = full_page[:remaining].decode(errors="ignore")
        remaining -= len(clipped.encode())
        recent = []
        current_id = str(body.request_id)
        with Session() as session:
            request_row = session.scalar(
                select(ChatRequest).where(
                    ChatRequest.book_id == str(book_id), ChatRequest.request_id == current_id
                )
            )
            request_pk = request_row.id
        for record in records:
            if record.chat_request_id == request_pk:
                continue
            cost = len(record.content.encode()) + 64
            if cost > remaining:
                break
            recent.append({"role": record.role, "content": record.content})
            remaining -= cost
        snapshot = {
            "page": body.page,
            "selected_text": body.selected_text,
            "page_text": clipped,
            "has_text": bool(page_text.strip()),
            "image_attached": image,
            "image_cache_key": cache_key,
            "policy_version": 1,
            "truncated": len(clipped) < len(page_text),
            "warnings": [],
        }
        if snapshot["truncated"]:
            snapshot["warnings"].append("페이지 본문이 입력 예산에 맞게 일부 생략되었습니다.")
        return ChatContext(
            prefix + f"<page_text>\n{clipped}\n</page_text>",
            list(reversed(recent)),
            image_url,
            body.response_style,
            body.model,
        ), snapshot

    def persist(request_pk, assistant_id, content, status, error=None, snapshot=None, usage=None):
        with Session.begin() as session:
            message = session.get(Message, assistant_id)
            row = session.get(ChatRequest, request_pk)
            message.content, message.status, message.error_code = content, status, error
            row.status, row.error_code = status, error
            if status not in ACTIVE:
                row.finished_at = now()
            if snapshot is not None:
                message.context_snapshot = snapshot
            if usage is not None:
                message.usage = usage

    async def run_response(queue, book_id, body, row_id, assistant_id):
        content, last_saved, last_length, finished = "", time.monotonic(), 0, False
        started = time.monotonic()
        try:
            async with asyncio.timeout(settings.llm_timeout_seconds):
                context, snapshot = await build_context(book_id, body)
                persist(row_id, assistant_id, content, "streaming", snapshot=snapshot)
                await queue.put(("context", snapshot))
                llm = adapter or make_adapter(settings, body.provider or settings.llm_provider)
                async for event in llm.stream(context):
                    if event["type"] == "delta":
                        content += event["text"]
                        await queue.put(
                            ("delta", {"text": event["text"], "assistant_message_id": assistant_id})
                        )
                        if time.monotonic() - last_saved >= 1 or len(content) - last_length >= 1000:
                            persist(row_id, assistant_id, content, "streaming")
                            last_saved, last_length = time.monotonic(), len(content)
                    elif event["type"] == "done":
                        persist(row_id, assistant_id, content, "completed", usage=event["usage"])
                        await queue.put(
                            (
                                "completed",
                                {"assistant_message_id": assistant_id, "usage": event["usage"]},
                            )
                        )
                        finished = True
                if not finished:
                    raise RuntimeError("incomplete_stream")
        except asyncio.CancelledError:
            if not finished:
                persist(row_id, assistant_id, content, "interrupted", "connection_closed")
            raise
        except Exception as error:
            code = "provider_failed"
            if isinstance(error, TimeoutError):
                code = "timeout"
            elif isinstance(error, AuthenticationError):
                code = "provider_authentication"
            elif isinstance(error, RateLimitError):
                code = "provider_rate_limit"
            elif isinstance(error, ValueError) and str(error) in {
                "images_unsupported",
                "image_required",
                "context_too_large",
                "image_too_large",
                "invalid_pdf",
            }:
                code = str(error)
            persist(row_id, assistant_id, content, "failed", code)
            await queue.put(
                ("failed", {"code": code, "retryable": True, "assistant_message_id": assistant_id})
            )
        finally:
            logger.info(
                "chat request=%s model=%s seconds=%.2f",
                row_id,
                body.model,
                time.monotonic() - started,
            )
            await queue.put(None)

    def stream_response(book_id, body, row_id, user_id, assistant_id, attempt):
        async def events():
            queue = asyncio.Queue()
            task = asyncio.create_task(run_response(queue, book_id, body, row_id, assistant_id))
            try:
                accepted = {
                    "request_id": str(body.request_id),
                    "user_message_id": user_id,
                    "assistant_message_id": assistant_id,
                    "attempt": attempt,
                }
                yield "event: accepted\ndata: " + json.dumps(accepted) + "\n\n"
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), 10)
                    except TimeoutError:
                        yield ": heartbeat\n\n"
                        continue
                    if event is None:
                        break
                    kind, data = event
                    yield f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    def accept_chat(book_id, body, retry=False):
        serialized = body.model_dump(mode="json")
        payload_hash = hashlib.sha256(json.dumps(serialized, sort_keys=True).encode()).hexdigest()
        try:
            with Session.begin() as session:
                session.execute(text("BEGIN IMMEDIATE"))
                book = get_book(session, book_id)
                if body.page > book.page_count:
                    fail(422, "page_out_of_range", "책의 페이지 범위를 벗어났습니다.")
                row = session.scalar(
                    select(ChatRequest).where(
                        ChatRequest.book_id == book.id,
                        ChatRequest.request_id == str(body.request_id),
                    )
                )
                if row and not retry:
                    code = (
                        "request_exists"
                        if row.payload_hash == payload_hash
                        else "request_payload_mismatch"
                    )
                    fail(409, code, "이미 처리된 요청입니다. 대화 이력을 확인해 주세요.")
                if retry and (row is None or row.status not in ("failed", "interrupted")):
                    fail(409, "retry_not_allowed", "실패하거나 중단된 답변만 재시도할 수 있습니다.")
                prefs = session.get(AppSettings, 1)
                selected_provider = body.provider or prefs.provider or settings.llm_provider
                selected_model = body.model or prefs.model or settings.llm_model
                if selected_provider == "fake" and settings.llm_provider != "fake":
                    fail(422, "invalid_provider", "테스트 모드는 서버에서만 활성화할 수 있습니다.")
                if selected_provider != "fake" and not (
                    settings.api_key_for(selected_provider) and selected_model
                ):
                    fail(
                        503,
                        "llm_not_configured",
                        "선택한 제공업체의 서버 API 키와 모델명을 설정해 주세요.",
                    )
                body = body.model_copy(
                    update={"model": selected_model, "provider": selected_provider}
                )
                serialized.update(model=selected_model, provider=selected_provider)
                thread = session.scalar(select(Thread).where(Thread.book_id == book.id))
                if retry:
                    row.attempt += 1
                    row.status, row.error_code, row.finished_at = "pending", None, None
                    user = session.scalar(
                        select(Message).where(
                            Message.chat_request_id == row.id, Message.role == "user"
                        )
                    )
                else:
                    row = ChatRequest(
                        book_id=book.id,
                        request_id=str(body.request_id),
                        payload_hash=payload_hash,
                        payload=serialized,
                    )
                    session.add(row)
                    session.flush()
                    user = Message(
                        thread_id=thread.id,
                        chat_request_id=row.id,
                        role="user",
                        content=body.question,
                        page=body.page,
                        selected_text=body.selected_text,
                    )
                    session.add(user)
                session.flush()
                assistant = Message(
                    thread_id=thread.id,
                    chat_request_id=row.id,
                    role="assistant",
                    page=body.page,
                    selected_text=body.selected_text,
                    status="pending",
                    attempt=row.attempt,
                    provider=selected_provider,
                    model=selected_model,
                )
                session.add(assistant)
                session.flush()
                ids = row.id, user.id, assistant.id, row.attempt
        except IntegrityError:
            fail(409, "chat_active", "이 책의 다른 답변이 진행 중입니다.")
        return stream_response(book_id, body, *ids)

    @app.post("/api/books/{book_id}/chat")
    async def chat(book_id: UUID, body: Question):
        return accept_chat(book_id, body)

    @app.post("/api/books/{book_id}/chat/{request_id}/retry")
    async def retry_chat(book_id: UUID, request_id: UUID):
        with Session() as session:
            get_book(session, book_id)
            row = session.scalar(
                select(ChatRequest).where(
                    ChatRequest.book_id == str(book_id), ChatRequest.request_id == str(request_id)
                )
            )
            if not row:
                fail(404, "request_not_found", "질문을 찾을 수 없습니다.")
            payload = dict(row.payload)
            if not payload.get("provider"):
                # Requests saved before provider selection still retain message metadata.
                original = session.scalar(
                    select(Message)
                    .where(
                        Message.chat_request_id == row.id,
                        Message.role == "assistant",
                    )
                    .order_by(Message.attempt.desc())
                    .limit(1)
                )
                if original and original.provider:
                    payload["provider"] = original.provider
            body = Question.model_validate(payload)
        return accept_chat(book_id, body, retry=True)

    # API routes are registered first. Never serve HTML for unknown /api paths.
    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    def missing_api(path: str):
        fail(404, "not_found", "API를 찾을 수 없습니다.")

    dist = ROOT / "frontend/dist"
    if dist.is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
        app.mount("/pdfjs", StaticFiles(directory=dist / "pdfjs"), name="pdfjs")

        @app.get("/favicon.svg", include_in_schema=False)
        def favicon():
            return FileResponse(dist / "favicon.svg")

        @app.get("/{path:path}")
        def spa(path: str):
            if path and not path.startswith("books/"):
                fail(404, "not_found", "페이지를 찾을 수 없습니다.")
            return FileResponse(dist / "index.html")

    return app
