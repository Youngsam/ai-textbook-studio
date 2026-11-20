import asyncio
import json
from uuid import uuid4

import pymupdf
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.config import Settings
from app.main import create_app
from app.models import Book, ChatRequest, Message, ReadingState, Thread


def make_pdf(pages=3, scan=False):
    with pymupdf.open() as document:
        for index in range(pages):
            page = document.new_page()
            if scan:
                pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 80, 80), False)
                pixmap.clear_with(200)
                page.insert_image(pymupdf.Rect(40, 40, 200, 200), pixmap=pixmap)
            else:
                page.insert_text(
                    (60, 80),
                    f"Learning page {index + 1}: A vector has both magnitude and direction.",
                )
                page.insert_text(
                    (60, 110), "Select this passage and ask a question about this page."
                )
        return document.tobytes()


@pytest.fixture
def settings(tmp_path):
    return Settings(
        _env_file=None,
        data_dir=tmp_path,
        database_url=f"sqlite:///{tmp_path}/learning.db",
        llm_provider="fake",
    )


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as client:
        yield client


def upload(client, title="Linear algebra", pdf=None):
    response = client.post(
        "/api/books",
        data={"title": title},
        files={
            "file": ("../../outside.pdf", pdf if pdf is not None else make_pdf(), "application/pdf")
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def ask(client, book, **changes):
    body = {
        "request_id": str(uuid4()),
        "question": "Explain this concept",
        "page": 1,
        "selected_text": "magnitude and direction",
        **changes,
    }
    return client.post(f"/api/books/{book['id']}/chat", json=body), body


def events(response):
    assert response.status_code == 200, response.text
    return [
        (block.splitlines()[0].removeprefix("event: "), json.loads(block.split("data: ", 1)[1]))
        for block in response.text.strip().split("\n\n")
        if block.startswith("event:")
    ]


def test_upload_range_state_restart_and_delete(settings):
    app = create_app(settings)
    with TestClient(app) as client:
        book = upload(client, pdf=make_pdf(130))
        assert book["page_count"] == 130
        assert "pdf_path" not in book
        assert client.get("/api/books").json()["items"][0]["id"] == book["id"]
        response = client.get(f"/api/books/{book['id']}/pdf", headers={"Range": "bytes=0-9"})
        assert response.status_code == 206
        assert response.content.startswith(b"%PDF-")
        assert (
            client.get(
                f"/api/books/{book['id']}/pdf", headers={"Range": "bytes=99999999-"}
            ).status_code
            == 416
        )
        state = {"page": 127, "zoom": 1.4, "scroll_offset": 0.37}
        assert client.put(f"/api/books/{book['id']}/state", json=state).status_code == 200
        assert (
            client.put(f"/api/books/{book['id']}/state", json={**state, "page": 131}).status_code
            == 422
        )
        response, _ = ask(client, book, page=127)
        assert [kind for kind, _ in events(response)][-1] == "completed"
    with TestClient(create_app(settings)) as client:
        restored = client.get(f"/api/books/{book['id']}/state").json()
        assert all(restored[key] == value for key, value in state.items())
        assert len(client.get(f"/api/books/{book['id']}/messages").json()["items"]) == 2
        assert client.delete(f"/api/books/{book['id']}").status_code == 204
        assert not (settings.data_dir / "books" / book["id"]).exists()
        with client.app.state.Session() as session:
            for model in (Book, ReadingState, Thread, ChatRequest, Message):
                assert session.scalar(select(func.count()).select_from(model)) == 0


def test_rename_book(client):
    book = upload(client)
    url = f"/api/books/{book['id']}"
    response = client.patch(url, json={"title": "  선형대수  ", "author": " 강 "})
    assert response.status_code == 200
    assert (response.json()["title"], response.json()["author"]) == ("선형대수", "강")
    assert client.get(url).json()["title"] == "선형대수"
    for body in ({"title": "   "}, {"title": "x" * 301}, {"title": "ok", "author": "x" * 301}):
        assert client.patch(url, json=body).status_code == 422
    assert client.patch(f"/api/books/{uuid4()}", json={"title": "x"}).status_code == 404


def test_bad_upload_cleanup(client, settings):
    for content in (b"not a PDF", b"%PDF-1.7 invalid document"):
        response = client.post(
            "/api/books", data={"title": "Broken"}, files={"file": ("book.pdf", content)}
        )
        assert response.status_code == 422
    assert not list((settings.data_dir / "tmp").iterdir())
    assert not list((settings.data_dir / "books").iterdir())


def test_encrypted_pdf_rejected(client):
    with pymupdf.open(stream=make_pdf(), filetype="pdf") as document:
        encrypted = document.tobytes(
            encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="reader"
        )
    response = client.post(
        "/api/books", data={"title": "Encrypted"}, files={"file": ("encrypted.pdf", encrypted)}
    )
    assert response.status_code == 422


def test_file_and_multipart_limits(settings):
    settings.max_upload_bytes = 100
    with TestClient(create_app(settings)) as client:
        assert (
            client.post(
                "/api/books", data={"title": "Large"}, files={"file": ("big.pdf", make_pdf())}
            ).status_code
            == 413
        )
        response = client.post(
            "/api/books",
            content=b"x" * (1024 * 1024 + 101),
            headers={"Content-Type": "multipart/form-data; boundary=test"},
        )
        assert response.status_code == 413
        response = client.post(
            "/api/books",
            content=iter([b"x" * (1024 * 1024), b"y" * 200]),
            headers={"Content-Type": "multipart/form-data; boundary=test"},
        )
        assert response.status_code == 413


def test_page_count_limit(settings):
    settings.max_pdf_pages = 1
    with TestClient(create_app(settings)) as client:
        assert (
            client.post(
                "/api/books", data={"title": "Large"}, files={"file": ("book.pdf", make_pdf())}
            ).status_code
            == 422
        )


def test_chat_context_idempotency_and_isolation(client):
    book = upload(client)
    other = upload(client, "Another book")
    response, body = ask(client, book)
    stream = events(response)
    assert stream[0][0] == "accepted"
    context = next(data for kind, data in stream if kind == "context")
    assert "magnitude" in context["page_text"]
    assert context["selected_text"] == body["selected_text"]
    assert not context["image_attached"]
    assert stream[-1][0] == "completed"
    assert (
        client.post(f"/api/books/{book['id']}/chat", json=body).json()["detail"]["code"]
        == "request_exists"
    )
    assert (
        client.post(f"/api/books/{book['id']}/chat", json={**body, "question": "different"}).json()[
            "detail"
        ]["code"]
        == "request_payload_mismatch"
    )
    assert client.get(f"/api/books/{other['id']}/messages").json()["items"] == []
    records = client.get(f"/api/books/{book['id']}/messages").json()["items"]
    assert [record["role"] for record in records] == ["user", "assistant"]
    assert records[1]["status"] == "completed"


def test_scan_auto_image_and_text_only_error(client):
    book = upload(client, pdf=make_pdf(1, scan=True))
    stream = events(ask(client, book)[0])
    context = next(data for kind, data in stream if kind == "context")
    assert context["image_attached"] and not context["has_text"]
    assert "base64" not in json.dumps(context)
    stream = events(ask(client, book, image_mode="never")[0])
    assert stream[-1][0] == "failed" and stream[-1][1]["code"] == "image_required"


class FailingAdapter:
    async def stream(self, context):
        yield {"type": "delta", "text": "partial answer"}
        raise RuntimeError("secret-provider-error")


def test_failure_preserves_question_partial_and_retry(settings):
    with TestClient(create_app(settings, adapter=FailingAdapter())) as client:
        book = upload(client)
        response, body = ask(client, book)
        assert events(response)[-1][0] == "failed"
        assert "secret-provider-error" not in response.text
        records = client.get(f"/api/books/{book['id']}/messages").json()["items"]
        assert records[-1]["content"] == "partial answer"
        assert records[-1]["status"] == "failed"
    with TestClient(create_app(settings)) as client:
        response = client.post(f"/api/books/{book['id']}/chat/{body['request_id']}/retry")
        assert events(response)[-1][0] == "completed"
        records = client.get(f"/api/books/{book['id']}/messages").json()["items"]
        assert len(records) == 3
        assert records[-2]["content"] == "partial answer"
        assert records[-1]["attempt"] == 2


def test_restart_recovers_pending_requests(settings):
    with TestClient(create_app(settings)) as client:
        book = upload(client)
        ask(client, book)
        with client.app.state.Session.begin() as session:
            row = session.scalar(select(ChatRequest))
            row.status = "streaming"
            message = session.scalar(select(Message).where(Message.role == "assistant"))
            message.status = "streaming"
    with TestClient(create_app(settings)) as client:
        records = client.get(f"/api/books/{book['id']}/messages").json()["items"]
        assert records[-1]["status"] == "interrupted"
        assert records[-1]["error_code"] == "server_restarted"
        assert client.delete(f"/api/books/{book['id']}").status_code == 204


def test_unconfigured_llm_reading_still_works(settings):
    settings.llm_provider = "openai"
    settings.openai_api_key = ""
    with TestClient(create_app(settings)) as client:
        book = upload(client)
        assert client.get(f"/api/books/{book['id']}/pdf").status_code == 200
        assert ask(client, book)[0].status_code == 503
        assert client.get("/api/settings").json()["llm_configured"] is False


def test_preferences_api_validation_and_origin(client):
    assert (
        client.put(
            "/api/settings", json={"response_style": "concise", "image_mode": "always"}
        ).status_code
        == 200
    )
    assert client.get("/api/settings").json()["image_mode"] == "always"
    assert "openai_api_key" not in client.get("/api/settings").text
    assert client.get("/api/health", headers={"Host": "attacker.example"}).status_code == 400
    assert (
        client.get("/api/health", headers={"Origin": "https://attacker.example"}).status_code == 403
    )
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/api/books/not-a-uuid/pdf").status_code == 422


class SlowAdapter:
    async def stream(self, context):
        yield {"type": "delta", "text": "starting"}
        await asyncio.sleep(1)


def test_timeout_is_persisted(settings):
    settings.llm_timeout_seconds = 0.01
    with TestClient(create_app(settings, adapter=SlowAdapter())) as client:
        book = upload(client)
        stream = events(ask(client, book)[0])
        assert stream[-1][1]["code"] == "timeout"
        assert (
            client.get(f"/api/books/{book['id']}/messages").json()["items"][-1]["status"]
            == "failed"
        )


def test_history_pagination(client):
    book = upload(client)
    ask(client, book)
    latest = client.get(f"/api/books/{book['id']}/messages?limit=1").json()
    earlier = client.get(
        f"/api/books/{book['id']}/messages?limit=1&before={latest['next_cursor']}"
    ).json()
    assert latest["items"][0]["role"] == "assistant"
    assert earlier["items"][0]["role"] == "user"
    assert earlier["next_cursor"] is None


def test_disconnect_preserves_partial_answer(settings):
    app = create_app(settings, adapter=SlowAdapter())
    with TestClient(app) as client:
        book = upload(client)
        payload = json.dumps(
            {"request_id": str(uuid4()), "question": "Explain", "page": 1}
        ).encode()

        async def disconnected_request():
            disconnected = asyncio.Event()
            sent_body = False

            async def receive():
                nonlocal sent_body
                if not sent_body:
                    sent_body = True
                    return {"type": "http.request", "body": payload, "more_body": False}
                await disconnected.wait()
                return {"type": "http.disconnect"}

            async def send(message):
                if b"event: delta" in message.get("body", b""):
                    disconnected.set()

            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": f"/api/books/{book['id']}/chat",
                "query_string": b"",
                "root_path": "",
                "server": ("testserver", 80),
                "client": ("test", 123),
                "headers": [(b"host", b"testserver"), (b"content-type", b"application/json")],
                "state": {},
            }
            await asyncio.wait_for(app(scope, receive, send), timeout=10)

        asyncio.run(disconnected_request())
        records = client.get(f"/api/books/{book['id']}/messages").json()["items"]
        assert records[-1]["content"] == "starting"
        assert records[-1]["status"] == "interrupted"


def test_project_api_key_takes_priority_over_inherited_key(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "inherited-test-only")
    dotenv = tmp_path / ".env"
    dotenv.write_text("OPENAI_API_KEY=project-test-only\n")
    assert Settings(_env_file=dotenv).openai_api_key == "project-test-only"
    assert Settings(_env_file=None).openai_api_key == "inherited-test-only"
    assert (
        Settings(_env_file=dotenv, openai_api_key="explicit-test-only").openai_api_key
        == "explicit-test-only"
    )


def test_selected_model_persists_and_reaches_chat_and_retry(settings):
    class CaptureAdapter:
        def __init__(self):
            self.models = []

        async def stream(self, context):
            self.models.append(context.model)
            if len(self.models) == 1:
                raise RuntimeError("synthetic failure")
            yield {"type": "delta", "text": "done"}
            yield {"type": "done", "usage": {}}

    adapter = CaptureAdapter()
    with TestClient(create_app(settings, adapter=adapter)) as client:
        assert "gpt-5.4" in client.get("/api/settings").json()["available_models"]
        assert client.put("/api/settings", json={"model": "custom-model"}).status_code == 200
        assert client.put("/api/settings", json={"model": "gpt-5.4"}).status_code == 200
        book = upload(client)
        response, body = ask(client, book)
        assert events(response)[-1][0] == "failed"
        client.put("/api/settings", json={"model": "gpt-5.4-mini"})
        retry = client.post(f"/api/books/{book['id']}/chat/{body['request_id']}/retry")
        assert events(retry)[-1][0] == "completed"
        assert adapter.models == ["gpt-5.4", "gpt-5.4"]
        records = client.get(f"/api/books/{book['id']}/messages").json()["items"]
        assert records[-1]["model"] == "gpt-5.4"
        assert ask(client, book, model="custom-model")[0].status_code == 200
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/settings").json()["model"] == "gpt-5.4-mini"


def test_existing_preferences_survive_model_migration(settings):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    from app.config import ROOT
    from app.db import make_engine

    settings.data_dir.mkdir(exist_ok=True)
    engine = make_engine(settings)
    config = Config(str(ROOT / "backend/alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "backend/migrations"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0001")
        connection.execute(
            text(
                "INSERT INTO app_settings(id, response_style, image_mode) VALUES(1, 'concise', 'always')"
            )
        )
    engine.dispose()
    with TestClient(create_app(settings)) as client:
        prefs = client.get("/api/settings").json()
        assert prefs["response_style"] == "concise"
        assert prefs["image_mode"] == "always"


def test_pdf_outline_and_empty_outline(client):
    with pymupdf.open(stream=make_pdf(), filetype="pdf") as document:
        document.set_toc([[1, "Chapter one", 1], [2, "Vectors", 3]])
        book = upload(client, pdf=document.tobytes())
    assert client.get(f"/api/books/{book['id']}/outline").json() == {
        "items": [
            {"level": 1, "title": "Chapter one", "page": 1},
            {"level": 2, "title": "Vectors", "page": 3},
        ]
    }
    plain = upload(client)
    assert client.get(f"/api/books/{plain['id']}/outline").json() == {"items": []}
    assert client.get(f"/api/books/{uuid4()}/outline").status_code == 404


def test_provider_persistence_and_retry(settings, monkeypatch):
    selected = []

    class Capture:
        async def stream(self, context):
            selected.append(context.model)
            if len(selected) == 1:
                raise RuntimeError("synthetic failure")
            yield {"type": "delta", "text": "done"}
            yield {"type": "done", "usage": {}}

    providers = []

    def factory(config, provider):
        providers.append(provider)
        return Capture()

    monkeypatch.setattr("app.main.make_adapter", factory)
    settings.anthropic_api_key = "synthetic-claude-key"
    settings.gemini_api_key = "synthetic-gemini-key"
    with TestClient(create_app(settings)) as client:
        assert (
            client.put(
                "/api/settings",
                json={
                    "provider": "claude",
                    "model": "claude-custom",
                },
            ).json()["llm_configured"]
            is True
        )
        book = upload(client)
        response, body = ask(client, book)
        assert events(response)[-1][0] == "failed"
        client.put("/api/settings", json={"provider": "gemini", "model": "gemini-custom"})
        retry = client.post(f"/api/books/{book['id']}/chat/{body['request_id']}/retry")
        assert events(retry)[-1][0] == "completed"
        assert providers == ["claude", "claude"]
        assert selected == ["claude-custom", "claude-custom"]
        records = client.get(f"/api/books/{book['id']}/messages").json()["items"]
        assert records[-1]["provider"] == "claude"
    with TestClient(create_app(settings)) as client:
        result = client.get("/api/settings")
        assert result.json()["provider"] == "gemini"
        assert result.json()["model"] == "gemini-custom"
        assert "synthetic-" not in result.text
        assert client.put("/api/settings", json={"provider": "unknown"}).status_code == 422


def test_model_probe_does_not_save_or_send_book_content(settings, monkeypatch):
    settings.llm_provider = "openai"
    settings.openrouter_api_key = "synthetic-router-key"
    closed = []

    class Probe:
        async def stream(self, context):
            assert context.prompt == "Reply with OK."
            assert context.image_url is None and context.history == []
            assert context.model == "vendor/custom"
            try:
                yield {"type": "delta", "text": "OK"}
            finally:
                closed.append(True)

    monkeypatch.setattr("app.main.make_adapter", lambda config, provider: Probe())
    with TestClient(create_app(settings)) as client:
        before = client.get("/api/settings").json()
        response = client.post(
            "/api/settings/test",
            json={
                "provider": "openrouter",
                "model": "vendor/custom",
            },
        )
        assert response.json()["ok"] is True
        assert closed == [True]
        assert client.get("/api/settings").json() == before
        assert (
            client.post(
                "/api/settings/test",
                json={
                    "provider": "gemini",
                    "model": "test",
                },
            ).json()["detail"]["code"]
            == "missing_api_key"
        )
        assert (
            client.post(
                "/api/settings/test",
                json={
                    "provider": "openrouter",
                    "model": " ",
                },
            ).status_code
            == 422
        )


def test_probe_provider_errors_are_safe(settings, monkeypatch):
    import httpx
    from openai import AuthenticationError

    settings.llm_provider = "openai"
    settings.openai_api_key = "synthetic-key"

    class Broken:
        async def stream(self, context):
            raise AuthenticationError(
                "secret-provider-error",
                response=httpx.Response(401, request=httpx.Request("POST", "https://test")),
                body=None,
            )
            yield

    monkeypatch.setattr("app.main.make_adapter", lambda config, provider: Broken())
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/settings/test", json={"provider": "openai", "model": "test"})
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "provider_authentication"
        assert "secret-provider-error" not in response.text


def test_portable_backup_restores_on_another_installation(settings, tmp_path):
    import sqlite3
    from contextlib import closing
    from pathlib import Path

    # The SQLite database need not be inside DATA_DIR.
    settings.database_url = f"sqlite:///{tmp_path}/separate-db/study.db"
    target = tmp_path.parent / f"backup-{uuid4()}"
    try:
        with TestClient(create_app(settings)) as client:
            original_pdf = make_pdf()
            book = upload(client, pdf=original_pdf)
            state = {"page": 2, "zoom": 1.6, "scroll_offset": 0.4}
            client.put(f"/api/books/{book['id']}/state", json=state).raise_for_status()
            response, _ = ask(client, book)
            events(response)
            history = client.get(f"/api/books/{book['id']}/messages").json()
            annotations = client.post(
                f"/api/books/{book['id']}/annotations",
                json={
                    "page": 2,
                    "selected_text": "A vector",
                    "color": "blue",
                    "note": "Backed up note",
                    "rects": [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.02}],
                },
            )
            assert annotations.status_code == 201
            saved_annotations = client.get(f"/api/books/{book['id']}/annotations").json()
            client.put("/api/settings", json={"response_style": "concise"}).raise_for_status()
            assert client.put("/api/settings/backup", json={"path": str(target)}).status_code == 200
            response = client.post("/api/backups")
            assert response.status_code == 201, response.text
            snapshot = Path(response.json()["path"])
            assert response.json()["book_count"] == 1
            assert (snapshot / "복구 안내.txt").is_file()
            assert not (snapshot / ".env").exists()
            assert not (snapshot / "learning.db-wal").exists()
            with closing(sqlite3.connect(snapshot / "learning.db")) as db:
                assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            # Future changes must not alter the existing snapshot.
            client.put(f"/api/books/{book['id']}/state", json={**state, "page": 3})
            second = client.post("/api/backups")
            assert second.status_code == 201
            assert second.json()["path"] != str(snapshot)
            assert client.delete(f"/api/books/{book['id']}").status_code == 204
        restored_settings = Settings(
            _env_file=None,
            data_dir=snapshot,
            database_url=f"sqlite:///{snapshot}/learning.db",
            llm_provider="fake",
        )
        with TestClient(create_app(restored_settings)) as restored:
            assert restored.get("/api/books").json()["items"][0]["id"] == book["id"]
            actual = restored.get(f"/api/books/{book['id']}/state").json()
            assert all(actual[key] == value for key, value in state.items())
            assert restored.get(f"/api/books/{book['id']}/messages").json() == history
            assert restored.get(f"/api/books/{book['id']}/annotations").json() == saved_annotations
            assert restored.get(f"/api/books/{book['id']}/pdf").content == original_pdf
            assert restored.get("/api/settings").json()["response_style"] == "concise"
    finally:
        import shutil

        shutil.rmtree(target, ignore_errors=True)


def test_backup_paths_and_incomplete_backup_cleanup(client, settings, tmp_path, monkeypatch):
    import app.backup as backup_module

    assert client.post("/api/backups").status_code == 422
    for path in ["", "relative/path", str(settings.data_dir), str(settings.data_dir / "books/new")]:
        assert client.put("/api/settings/backup", json={"path": path}).status_code == 422
    link = tmp_path.parent / f"link-{uuid4()}"
    link.symlink_to(settings.data_dir, target_is_directory=True)
    try:
        assert client.put("/api/settings/backup", json={"path": str(link)}).status_code == 422
    finally:
        link.unlink()
    target = tmp_path.parent / f"backup-{uuid4()}"
    try:
        book = upload(client)
        client.put("/api/settings/backup", json={"path": str(target)}).raise_for_status()
        source = settings.data_dir / "books" / book["id"] / "original.pdf"
        source.write_bytes(b"corrupted")
        assert client.post("/api/backups").status_code == 422
        assert list(target.iterdir()) == []
        source.write_bytes(make_pdf())

        def denied(*args, **kwargs):
            raise PermissionError("disk unavailable")

        monkeypatch.setattr(backup_module, "copy_pdf", denied)
        assert client.post("/api/backups").status_code == 503
        assert list(target.iterdir()) == []
    finally:
        target.rmdir()


def test_concurrent_backups_rejected_and_lock_released(client, tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    import app.main as main_module

    target = tmp_path.parent / f"backup-{uuid4()}"
    client.put("/api/settings/backup", json={"path": str(target)}).raise_for_status()
    entered, release = Event(), Event()
    original = main_module.create_backup

    def paused(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)

    monkeypatch.setattr(main_module, "create_backup", paused)
    try:
        with ThreadPoolExecutor() as executor:
            first = executor.submit(client.post, "/api/backups")
            try:
                assert entered.wait(5)
                assert client.post("/api/backups").status_code == 409
            finally:
                release.set()
            assert first.result().status_code == 201
        assert client.post("/api/backups").status_code == 201
    finally:
        import shutil

        shutil.rmtree(target, ignore_errors=True)


def test_automatic_backup_changes_failures_and_restart(client, settings, tmp_path, monkeypatch):
    import shutil
    from datetime import datetime, timedelta, timezone
    from pathlib import Path

    import app.main as main_module

    target = tmp_path.parent / f"backup-{uuid4()}"
    try:
        book = upload(client)
        client.put("/api/settings/backup", json={"path": str(target)}).raise_for_status()
        run = client.app.state.run_backup
        tick = datetime.now(timezone.utc)
        first = run(automatic=True, checked_at=tick)
        assert first and Path(first["path"]).is_dir()
        # Duplicate state writes change timestamps but not the learning data.
        state = client.get(f"/api/books/{book['id']}/state").json()
        client.put(f"/api/books/{book['id']}/state", json=state).raise_for_status()
        assert run(automatic=True, checked_at=tick + timedelta(minutes=30)) is None
        assert len(list(target.iterdir())) == 1
        client.put(f"/api/books/{book['id']}/state", json={**state, "page": 2})
        assert run(automatic=True, checked_at=tick + timedelta(minutes=31)) is None
        second = run(automatic=True, checked_at=tick + timedelta(minutes=60))
        assert second
        original = main_module.create_backup

        def unavailable(*args):
            raise OSError("disk disconnected")

        monkeypatch.setattr(main_module, "create_backup", unavailable)
        client.put("/api/settings", json={"image_mode": "never"}).raise_for_status()
        with pytest.raises(HTTPException) as error:
            run(automatic=True, checked_at=tick + timedelta(minutes=90))
        assert error.value.status_code == 503
        status = client.get("/api/settings/backup").json()
        assert status["error"]
        assert status["last_path"] == second["path"]
        assert Path(first["path"]).is_dir() and Path(second["path"]).is_dir()
        monkeypatch.setattr(main_module, "create_backup", original)
        assert run(automatic=True, checked_at=tick + timedelta(minutes=91)) is None
        assert run(automatic=True, checked_at=tick + timedelta(minutes=120))
        assert client.get("/api/settings/backup").json()["error"] is None
        # A new server retains its baseline and does not back up its own status writes.
        with TestClient(create_app(settings)) as restarted:
            assert (
                restarted.app.state.run_backup(
                    automatic=True, checked_at=tick + timedelta(minutes=150)
                )
                is None
            )
            assert restarted.get("/api/settings/backup").json()["last_success_at"]
            restarted.put("/api/settings/backup", json={"path": str(target), "auto_enabled": False})
            assert (
                restarted.app.state.run_backup(
                    automatic=True, checked_at=tick + timedelta(minutes=180)
                )
                is None
            )
    finally:
        shutil.rmtree(target, ignore_errors=True)


def test_backup_retention_and_changes_during_snapshot(client, tmp_path, monkeypatch):
    import shutil
    from datetime import datetime, timedelta, timezone
    from pathlib import Path

    import app.main as main_module

    target = tmp_path.parent / f"backup-{uuid4()}"
    try:
        book = upload(client)
        client.put("/api/settings/backup", json={"path": str(target), "auto_enabled": False})
        # Other installations, unknown files, and legacy backups are never pruned.
        target.mkdir()
        unrelated = target / "textbook-studio-20200101T000000Z-00000000"
        unrelated.mkdir()
        (unrelated / "backup.json").write_text(
            '{"format":"textbook-studio","version":1,"source_id":"other"}'
        )
        (target / "notes.txt").write_text("keep")
        paths = []
        for _ in range(12):
            response = client.post("/api/backups")
            assert response.status_code == 201, response.text
            paths.append(Path(response.json()["path"]))
        assert not paths[0].exists() and not paths[1].exists()
        assert all(path.is_dir() for path in paths[2:])
        assert unrelated.is_dir() and (target / "notes.txt").read_text() == "keep"
        original = main_module.create_backup

        def change_after_snapshot(*args):
            result = original(*args)
            with client.app.state.Session.begin() as session:
                session.get(ReadingState, book["id"]).page = 2
            return result

        client.put("/api/settings/backup", json={"path": str(target)})
        monkeypatch.setattr(main_module, "create_backup", change_after_snapshot)
        tick = datetime.now(timezone.utc)
        assert client.app.state.run_backup(automatic=True, checked_at=tick)
        monkeypatch.setattr(main_module, "create_backup", original)
        assert client.app.state.run_backup(automatic=True, checked_at=tick + timedelta(minutes=30))
    finally:
        shutil.rmtree(target, ignore_errors=True)


def test_automatic_backup_worker_runs_without_browser(settings, tmp_path, monkeypatch):
    import shutil
    from threading import Event

    import app.main as main_module

    target = tmp_path.parent / f"backup-{uuid4()}"
    completed = Event()
    original = main_module.create_backup

    def observe(*args):
        result = original(*args)
        completed.set()
        return result

    monkeypatch.setattr(main_module, "INTERVAL_SECONDS", 0.05)
    monkeypatch.setattr(main_module, "create_backup", observe)
    try:
        with TestClient(create_app(settings)) as client:
            client.put("/api/settings/backup", json={"path": str(target)}).raise_for_status()
            assert completed.wait(5), "Server worker must back up without browser activity"
        assert len(list(target.glob("textbook-studio-*"))) == 1
    finally:
        shutil.rmtree(target, ignore_errors=True)


def test_extracted_outline_endpoint_cache_and_recovery(client, settings):
    from tests.test_outline import document_with_contents

    with document_with_contents() as document:
        book = upload(client, pdf=document.tobytes())
    url = f"/api/books/{book['id']}/outline"
    result = client.get(url)
    assert result.status_code == 200
    assert [i["page"] for i in result.json()["items"]] == [2, 4, 6]
    cache = settings.data_dir / "books" / book["id"] / "outline-v1.json"
    assert cache.exists()
    assert client.get(url).json() == result.json()
    # Older recognition rules may have cached a plausible but truncated outline.
    stored = json.loads(cache.read_text())
    stored["version"] = 1
    stored["result"] = {"items": []}
    cache.write_text(json.dumps(stored))
    assert client.get(url).json() == result.json()
    cache.write_text("interrupted cache")
    assert client.get(url).json() == result.json()


def test_annotations_persist_scope_validate_and_cascade(settings):
    from app.backup import current_fingerprint
    from app.models import Annotation

    with TestClient(create_app(settings)) as client:
        book, other = upload(client), upload(client, title="Other")
        url = f"/api/books/{book['id']}/annotations"
        body = {
            "page": 2,
            "selected_text": "magnitude and direction",
            "color": "green",
            "note": "Remember this vector",
            "rects": [
                {"x": 0.1, "y": 0.2, "width": 0.4, "height": 0.02},
                {"x": 0.1, "y": 0.23, "width": 0.2, "height": 0.02},
            ],
        }
        engine = client.app.state.Session.kw["bind"]
        before = current_fingerprint(engine)
        response = client.post(url, json=body)
        assert response.status_code == 201, response.text
        annotation = response.json()
        assert current_fingerprint(engine) != before
        assert annotation["rects"] == body["rects"]
        assert client.get(url).json()["items"] == [annotation]
        wrong = f"/api/books/{other['id']}/annotations/{annotation['id']}"
        assert client.put(wrong, json={"color": "blue", "note": "wrong"}).status_code == 404
        assert client.delete(wrong).status_code == 404
        for invalid in (
            {"page": 4},
            {"page": 0},
            {"color": "red"},
            {"selected_text": "  "},
            {"rects": []},
            {"rects": [{"x": 0.9, "y": 0, "width": 0.2, "height": 0.1}]},
            {"note": "x" * 10001},
        ):
            assert client.post(url, json={**body, **invalid}).status_code == 422
    with TestClient(create_app(settings)) as client:
        restored = client.get(url).json()["items"][0]
        assert restored == annotation
        endpoint = f"{url}/{annotation['id']}"
        result = client.put(endpoint, json={"note": "", "color": "pink"})
        assert result.status_code == 200
        assert result.json()["note"] == ""
        assert result.json()["color"] == "pink"
        assert client.delete(endpoint).status_code == 204
        assert client.get(url).json()["items"] == []
        assert client.delete(endpoint).status_code == 404
        client.post(url, json=body)
        assert client.delete(f"/api/books/{book['id']}").status_code == 204
        with client.app.state.Session() as session:
            assert session.scalar(select(func.count()).select_from(Annotation)) == 0


def test_crop_attaches_image_despite_never_mode(client, settings):
    book = upload(client)
    crop = {"x": 0.05, "y": 0.05, "width": 0.45, "height": 0.2}
    response, body = ask(client, book, crop=crop, image_mode="never")
    stream = events(response)
    context = next(data for kind, data in stream if kind == "context")
    assert stream[-1][0] == "completed"
    assert context["image_attached"] and context["crop"] == crop
    image = settings.data_dir / "books" / book["id"] / "images" / context["image_cache_key"]
    pix = pymupdf.Pixmap(str(image))
    # This must be the selected region, rendered at higher resolution than the page.
    assert 1069 <= pix.width <= 1073
    assert 672 <= pix.height <= 676



@pytest.mark.parametrize("crop", [
    {"x": 0.9, "y": 0, "width": 0.2, "height": 0.2},
    {"x": 0, "y": 0, "width": 0, "height": 0.2},
    {"x": -0.1, "y": 0, "width": 0.2, "height": 0.2},
])
def test_crop_rejects_invalid_bounds(client, crop):
    book = upload(client)
    assert ask(client, book, crop=crop)[0].status_code == 422


def test_crop_requires_image_support(settings):
    settings.llm_supports_images = False
    with TestClient(create_app(settings)) as client:
        book = upload(client)
        result = events(ask(client, book, crop={"x": 0, "y": 0, "width": 0.5, "height": 0.5})[0])
        assert result[-1][1]["code"] == "images_unsupported"


def test_failed_crop_retry_preserves_region(settings):
    crop = {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.3}
    with TestClient(create_app(settings, adapter=FailingAdapter())) as client:
        book = upload(client)
        response, body = ask(client, book, crop=crop, image_mode="never")
        assert events(response)[-1][0] == "failed"
    with TestClient(create_app(settings)) as client:
        result = events(client.post(f"/api/books/{book['id']}/chat/{body['request_id']}/retry"))
        context = next(data for kind, data in result if kind == "context")
        assert context["crop"] == crop and context["image_attached"]
        assert result[-1][0] == "completed"


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_crop_matches_display_coordinates_with_rotation(tmp_path, rotation):
    from app.pdf import PdfService

    path = tmp_path / "rotated.pdf"
    image = tmp_path / "crop.jpg"
    with pymupdf.open() as doc:
        page = doc.new_page(width=400, height=300)
        page.draw_rect(pymupdf.Rect(0, 0, 200, 150), fill=(1, 0, 0), color=None)
        page.set_rotation(rotation)
        doc.save(path)
        full = page.get_pixmap()
        expected = full.pixel(int(full.width * 0.15), int(full.height * 0.15))
    service = PdfService(30)
    asyncio.run(service.run("page", path, 1, str(image),
        crop={"x": 0.1, "y": 0.1, "width": 0.1, "height": 0.1}))
    actual = pymupdf.Pixmap(str(image))
    assert all(abs(a - b) < 5 for a, b in zip(actual.pixel(actual.width // 2, actual.height // 2), expected))


class TranslationAdapter:
    def __init__(self):
        self.contexts = []

    async def stream(self, context):
        self.contexts.append(context)
        await asyncio.sleep(0.05)
        yield {"type": "delta", "text": "## 번역된 페이지\n\n벡터는 크기와 방향을 가진다."}
        yield {"type": "done", "usage": {}}


def test_page_translation_cache_context_and_cascade(settings):
    import httpx

    from app.backup import current_fingerprint
    from app.llm import TRANSLATION_INSTRUCTIONS
    from app.models import PageTranslation

    adapter = TranslationAdapter()
    with TestClient(create_app(settings, adapter=adapter)) as client:
        book = upload(client)
        url = f"/api/books/{book['id']}/pages/2/translation"
        assert client.get(url).json() is None
        assert client.post(f"/api/books/{book['id']}/pages/4/translation").status_code == 422
        assert client.get(f"/api/books/{book['id']}/pages/0/translation").status_code == 422
        engine = client.app.state.Session.kw["bind"]
        before = current_fingerprint(engine)

        async def concurrent():
            transport = httpx.ASGITransport(app=client.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
                return await asyncio.gather(http.post(url), http.post(url))

        responses = asyncio.run(concurrent())
        assert [response.status_code for response in responses] == [200, 200]
        assert len(adapter.contexts) == 1
        translation = responses[0].json()
        assert translation == responses[1].json()
        assert translation["content"].startswith("## 번역된 페이지")
        assert translation["page"] == 2 and not translation["truncated"]
        context = adapter.contexts[0]
        assert context.instructions == TRANSLATION_INSTRUCTIONS
        assert context.max_output_tokens == settings.translation_max_output_tokens
        assert context.history == []
        # Translation attaches the page image even though chat image mode is "auto".
        assert context.image_url.startswith("data:image/jpeg;base64,")
        assert "Learning page 2" in context.prompt
        assert "<figures>" not in context.prompt and translation["figures"] == []
        assert current_fingerprint(engine) != before
    with TestClient(create_app(settings)) as client:
        assert client.get(url).json() == translation
        retranslated = client.post(url).json()
        assert retranslated["content"].startswith("**테스트 번역**")
        assert client.get(url).json() == retranslated
        assert client.delete(f"/api/books/{book['id']}").status_code == 204
        with client.app.state.Session() as session:
            assert session.scalar(select(func.count()).select_from(PageTranslation)) == 0


def test_page_translation_failures_are_safe_and_not_cached(settings):
    with TestClient(create_app(settings, adapter=FailingAdapter())) as client:
        book = upload(client)
        url = f"/api/books/{book['id']}/pages/1/translation"
        response = client.post(url)
        assert response.status_code == 502
        assert "secret-provider-error" not in response.text
        assert client.get(url).json() is None
    with TestClient(create_app(settings)) as client:
        scan = upload(client, pdf=make_pdf(1, scan=True))
        url = f"/api/books/{scan['id']}/pages/1/translation"
        client.put("/api/settings", json={"image_mode": "never"})
        assert "페이지 이미지도 첨부" in client.post(url).json()["content"]
    without_images = settings.model_copy(update={"llm_supports_images": False})
    with TestClient(create_app(without_images)) as client:
        text_book = upload(client)
        text_url = f"/api/books/{text_book['id']}/pages/1/translation"
        assert "페이지 이미지도 첨부" not in client.post(text_url).json()["content"]
        response = client.post(url)
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "images_unsupported"


def test_translation_model_defaults_to_chat_model_and_can_be_separate(settings):
    adapter = TranslationAdapter()
    with TestClient(create_app(settings, adapter=adapter)) as client:
        book = upload(client)
        url = f"/api/books/{book['id']}/pages/1/translation"
        prefs = client.get("/api/settings").json()
        assert prefs["translation_provider"] == "" and prefs["translation_model"] == ""
        assert prefs["translation_configured"]
        client.put("/api/settings", json={"provider": "fake", "model": "chat-model"})
        assert client.post(url).json()["model"] == "chat-model"

        response = client.put(
            "/api/settings",
            json={"translation_provider": "fake", "translation_model": "  translate-model "},
        )
        assert response.status_code == 200
        assert response.json()["translation_model"] == "translate-model"
        assert response.json()["model"] == "chat-model"
        assert client.post(url).json()["model"] == "translate-model"
        assert adapter.contexts[-1].model == "translate-model"
        # Chat-only saves leave the translation choice untouched.
        client.put("/api/settings", json={"response_style": "concise"})
        assert client.get("/api/settings").json()["translation_model"] == "translate-model"

        for invalid in (
            {"translation_provider": "fake", "translation_model": ""},
            {"translation_provider": "fake"},
            {"translation_provider": "fake", "translation_model": "a\nb"},
            {"translation_provider": "unknown", "translation_model": "x"},
        ):
            assert client.put("/api/settings", json=invalid).status_code == 422

        reset = client.put(
            "/api/settings", json={"translation_provider": "", "translation_model": "ignored"}
        ).json()
        assert reset["translation_provider"] == "" and reset["translation_model"] == ""
        assert client.post(url).json()["model"] == "chat-model"
    # An inherited process key must not make the unconfigured provider look ready.
    without_key = settings.model_copy(update={"openai_api_key": ""})
    with TestClient(create_app(without_key)) as client:
        response = client.put(
            "/api/settings", json={"translation_provider": "openai", "translation_model": "m"}
        )
        assert response.json()["translation_configured"] is False
        book = client.get("/api/books").json()["items"][0]
        response = client.post(f"/api/books/{book['id']}/pages/1/translation")
        assert response.status_code == 503


def test_settings_update_rejects_server_only_translation_provider(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        database_url=f"sqlite:///{tmp_path}/learning.db",
        llm_provider="openai",
    )
    with TestClient(create_app(settings)) as client:
        response = client.put(
            "/api/settings", json={"translation_provider": "fake", "translation_model": "x"}
        )
        assert response.status_code == 422


def make_figure_pdf():
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((60, 80), "A bar chart follows. Figure 1.1 shows returns.")
        page.draw_line((60, 100), (540, 100))
        for index in range(5):
            page.draw_rect(
                pymupdf.Rect(100 + index * 60, 300, 140 + index * 60, 420 - index * 15),
                fill=(0, 0, 1),
            )
        pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 40), False)
        pixmap.clear_with(90)
        page.insert_image(pymupdf.Rect(150, 500, 450, 700), pixmap=pixmap)
        page.insert_text((60, 740), "Figure 1.2 An embedded photograph.")
        return document.tobytes()


def test_translation_crops_figures_and_serves_them(settings):
    adapter = TranslationAdapter()
    with TestClient(create_app(settings, adapter=adapter)) as client:
        book = upload(client, pdf=make_figure_pdf())
        url = f"/api/books/{book['id']}/pages/1/translation"
        translation = client.post(url).json()
        figures = translation["figures"]
        assert len(figures) == 2
        chart, photo = figures
        assert chart["y"] < photo["y"]
        assert abs(chart["x"] - 100 / 595) < 0.02 and abs(photo["y"] - 500 / 842) < 0.02
        prompt = adapter.contexts[-1].prompt
        assert "<figures>" in prompt and "그림 2:" in prompt and "그림 3:" not in prompt
        assert client.get(url).json()["figures"] == figures

        response = client.get(f"{url}/figures/2")
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/jpeg"
        image = pymupdf.Pixmap(response.content)
        assert image.width > image.height
        center = image.pixel(image.width // 2, image.height // 2)
        assert all(abs(channel - 90) < 10 for channel in center)
        for missing in (0, 3):
            assert client.get(f"{url}/figures/{missing}").status_code == 404
        plain = upload(client)
        assert client.get(f"/api/books/{plain['id']}/pages/1/translation/figures/1").status_code == 404
    with TestClient(create_app(settings)) as client:
        assert "![그림 1](figure:1)" in client.post(url).json()["content"]


class BrokenMathAdapter:
    """First reply drops a closing $; later replies are the repair pass."""

    def __init__(self, repairs):
        self.repairs = list(repairs)
        self.contexts = []

    async def stream(self, context):
        from app.llm import MATH_REPAIR_INSTRUCTIONS

        self.contexts.append(context)
        if context.instructions == MATH_REPAIR_INSTRUCTIONS:
            text = self.repairs.pop(0)
        else:
            text = (
                "## 2.8 변수 변환\n\n"
                "아핀 변환 $f(\\mathbf{x})=\\mathbf{A}\\mathbf{x}+\\mathbf{b)의 예. "
                "여기서는 $\\mathbf{A}=\\mathbf{I}$이다.\n\n"
                "정상 문단 $a+b$."
            )
        yield {"type": "delta", "text": text}
        yield {"type": "done", "usage": {}}


def test_translation_repairs_broken_math_paragraphs(settings):
    fixed = (
        "아핀 변환 $f(\\mathbf{x})=\\mathbf{A}\\mathbf{x}+\\mathbf{b}$의 예. "
        "여기서는 $\\mathbf{A}=\\mathbf{I}$이다."
    )
    adapter = BrokenMathAdapter([f'<p id="1">\n{fixed}\n</p>'])
    with TestClient(create_app(settings, adapter=adapter)) as client:
        book = upload(client)
        content = client.post(f"/api/books/{book['id']}/pages/1/translation").json()["content"]
        assert content == f"## 2.8 변수 변환\n\n{fixed}\n\n정상 문단 $a+b$."
        repair = adapter.contexts[1]
        assert '<p id="1">' in repair.prompt and '<p id="0">' not in repair.prompt
        assert "$ 짝이 맞지 않음" in repair.prompt
        assert repair.image_url and repair.history == []


def test_translation_keeps_original_when_repair_is_still_broken(settings):
    still_broken = '<p id="1">\n여전히 $x 깨짐\n</p>'
    adapter = BrokenMathAdapter([still_broken])
    with TestClient(create_app(settings, adapter=adapter)) as client:
        book = upload(client)
        content = client.post(f"/api/books/{book['id']}/pages/1/translation").json()["content"]
        assert "\\mathbf{b)의 예" in content and "깨짐" not in content
        assert len(adapter.contexts) == 2
    # Valid translations never trigger a repair request.
    clean = TranslationAdapter()
    with TestClient(create_app(settings, adapter=clean)) as client:
        client.post(f"/api/books/{book['id']}/pages/1/translation")
        assert len(clean.contexts) == 1
