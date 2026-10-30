"""Portable snapshots: a standalone SQLite database and immutable original PDFs."""

import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from app.config import Settings

INTERVAL_SECONDS = 30 * 60
RETAIN_COUNT = 10


def fingerprint(connection):
    """Hash a consistent DB view, excluding backup bookkeeping and visit timestamps."""
    digest = hashlib.sha256()
    for table in (
        "books",
        "reading_states",
        "chat_threads",
        "chat_requests",
        "messages",
        "app_settings",
    ):
        info = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
        columns = [row[1] for row in info]
        primary = ", ".join(f'"{row[1]}"' for row in sorted(info, key=lambda row: row[5]) if row[5])
        columns = [
            name
            for name in columns
            if not (
                (table == "app_settings" and name.startswith("backup_"))
                or (table == "books" and name in ("updated_at", "last_opened_at"))
                or (table == "reading_states" and name == "updated_at")
            )
        ]
        names = ", ".join(f'"{name}"' for name in columns)
        digest.update((table + names).encode())
        for row in connection.execute(f'SELECT {names} FROM "{table}" ORDER BY {primary}'):
            digest.update(json.dumps(row, ensure_ascii=False).encode())
            digest.update(b"\n")
    return digest.hexdigest()


def current_fingerprint(engine):
    connection = engine.raw_connection()
    try:
        source = connection.driver_connection
        source.execute("BEGIN")
        return fingerprint(source)
    finally:
        connection.rollback()
        connection.close()


def prune_backups(target, source_id):
    """Only prune completed snapshots owned by this installation, never arbitrary folders."""
    if not source_id:
        return
    snapshots = []
    for item in target.glob("textbook-studio-*"):
        if not re.fullmatch(r"textbook-studio-\d{8}T\d{6}Z-[0-9a-f]{8}", item.name):
            continue
        if item.is_symlink() or not item.is_dir():
            continue
        manifest = item / "backup.json"
        if manifest.is_symlink() or not manifest.is_file():
            continue
        try:
            metadata = json.loads(manifest.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict):
                continue
            if (
                metadata.get("format") == "textbook-studio"
                and metadata.get("version") == 1
                and metadata.get("source_id") == source_id
                and (item / "learning.db").is_file()
                and (item / "books").is_dir()
            ):
                snapshots.append(
                    (datetime.fromisoformat(metadata["created_at"]).timestamp(), item.name, item)
                )
        except (ValueError, KeyError, TypeError):
            continue
    for _, _, item in sorted(snapshots, reverse=True)[RETAIN_COUNT:]:
        shutil.rmtree(item)


def destination(value: str, settings: Settings) -> Path:
    path = Path(value.strip()).expanduser()
    if not value.strip() or not path.is_absolute():
        raise ValueError("백업 경로는 절대 경로로 입력해 주세요.")
    path = path.resolve()
    database = Path(settings.database_url.removeprefix("sqlite:///")).resolve()
    if (
        path.is_relative_to(settings.data_dir)
        or path == database
        or path.is_relative_to(database.parent / "books")
    ):
        raise ValueError("현재 데이터 폴더 밖의 백업 경로를 입력해 주세요.")
    if path.exists() and not path.is_dir():
        raise ValueError("백업 경로가 폴더가 아닙니다.")
    return path


def create_backup(engine, settings: Settings, target: Path):
    target.mkdir(parents=True, exist_ok=True)
    created_at = datetime.now(timezone.utc).isoformat()
    stamp = datetime.fromisoformat(created_at).strftime("%Y%m%dT%H%M%SZ")
    final = target / f"textbook-studio-{stamp}-{uuid4().hex[:8]}"
    stage = Path(tempfile.mkdtemp(prefix=".textbook-backup-", dir=target))
    try:
        with closing(sqlite3.connect(stage / "learning.db")) as snapshot:
            connection = engine.raw_connection()
            try:
                connection.driver_connection.backup(snapshot)
            finally:
                connection.close()
            # Store a self-contained DB; the live source uses WAL mode.
            snapshot.execute("PRAGMA journal_mode=DELETE")
            books = snapshot.execute("SELECT id, pdf_sha256, status FROM books").fetchall()
            if snapshot.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("데이터베이스 검증에 실패했습니다.")
            content_fingerprint = fingerprint(snapshot)
            state = json.loads(
                snapshot.execute("SELECT backup_state FROM app_settings WHERE id=1").fetchone()[0]
            )
            source_id = state.get("source_id")
        (stage / "books").mkdir()
        for book_id, digest, status in books:
            if status != "ready":
                raise ValueError("삭제 중인 책이 있습니다. 삭제를 완료한 뒤 다시 백업해 주세요.")
            # Only application-created UUID paths are allowed in the portable snapshot.
            book_id = str(UUID(book_id))
            source = settings.data_dir / "books" / book_id / "original.pdf"
            output = stage / "books" / book_id / "original.pdf"
            output.parent.mkdir()
            shutil.copyfile(source, output)
            with output.open("rb") as file:
                if hashlib.file_digest(file, "sha256").hexdigest() != digest:
                    raise ValueError("원본 PDF 검증에 실패했습니다. 데이터 파일을 확인해 주세요.")
        (stage / "backup.json").write_text(
            json.dumps(
                {
                    "format": "textbook-studio",
                    "version": 1,
                    "created_at": created_at,
                    "book_count": len(books),
                    "fingerprint": content_fingerprint,
                    "source_id": source_id,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        (stage / "복구 안내.txt").write_text(
            "AI Textbook Studio 복구 방법\n\n"
            "1. 앱 서버를 종료합니다.\n"
            "2. 이 폴더 전체를 사용할 컴퓨터의 로컬 디스크로 복사합니다.\n"
            "3. 프로젝트 .env에서 DATA_DIR을 복사한 폴더의 절대 경로로 지정합니다.\n"
            "4. DATABASE_URL=sqlite:////복사한/폴더/learning.db 로 지정합니다.\n"
            "   예: DATA_DIR=/Users/me/restored-study\n"
            "       DATABASE_URL=sqlite:////Users/me/restored-study/learning.db\n"
            "5. 필요한 제공업체 API 키를 .env에 설정하고 서버를 시작합니다.\n\n"
            "PDF·대화·독서 위치·서버 앱 설정이 복원됩니다.\n"
            "API 키와 브라우저별 화면 설정은 포함하지 않습니다.\n"
            "원본 백업은 보관하고 복사본을 사용하세요. 같은 버전 또는 호환되는 새 버전을 사용하세요.\n",
            encoding="utf-8",
        )
        stage.rename(final)
        return {
            "path": str(final),
            "book_count": len(books),
            "created_at": created_at,
            "fingerprint": content_fingerprint,
            "source_id": source_id,
        }
    finally:
        if stage.exists():
            shutil.rmtree(stage)
