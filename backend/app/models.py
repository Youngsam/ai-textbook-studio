from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import JSON, CheckConstraint, ForeignKey, Index, String, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def uid():
    return str(uuid4())


def now():
    return datetime.now(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class Book(Base):
    __tablename__ = "books"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    title: Mapped[str]
    author: Mapped[str] = mapped_column(default="")
    pdf_sha256: Mapped[str]
    page_count: Mapped[int]
    status: Mapped[str] = mapped_column(default="ready")
    created_at: Mapped[str] = mapped_column(default=now)
    updated_at: Mapped[str] = mapped_column(default=now)
    last_opened_at: Mapped[str] = mapped_column(default=now, index=True)


class ReadingState(Base):
    __tablename__ = "reading_states"
    __table_args__ = (
        CheckConstraint(
            "page >= 1 AND zoom >= 0.5 AND zoom <= 3 AND scroll_offset >= 0 AND scroll_offset <= 1"
        ),
    )
    book_id: Mapped[str] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), primary_key=True
    )
    page: Mapped[int] = mapped_column(default=1)
    zoom: Mapped[float] = mapped_column(default=1.0)
    scroll_offset: Mapped[float] = mapped_column(default=0.0)
    updated_at: Mapped[str] = mapped_column(default=now)


class Thread(Base):
    __tablename__ = "chat_threads"
    id: Mapped[str] = mapped_column(primary_key=True, default=uid)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), unique=True)
    created_at: Mapped[str] = mapped_column(default=now)


class ChatRequest(Base):
    __tablename__ = "chat_requests"
    __table_args__ = (
        Index(
            "one_active_chat_per_book",
            "book_id",
            unique=True,
            sqlite_where=text("status IN ('pending', 'streaming')"),
        ),
    )
    id: Mapped[str] = mapped_column(primary_key=True, default=uid)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    request_id: Mapped[str]
    payload_hash: Mapped[str]
    payload: Mapped[dict] = mapped_column(JSON)
    attempt: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(default="pending")
    error_code: Mapped[str | None]
    started_at: Mapped[str] = mapped_column(default=now)
    finished_at: Mapped[str | None]


Index("chat_request_key", ChatRequest.book_id, ChatRequest.request_id, unique=True)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint("role IN ('user', 'assistant')"),
        Index("message_history", "thread_id", "created_at", "id"),
    )
    id: Mapped[str] = mapped_column(primary_key=True, default=uid)
    thread_id: Mapped[str] = mapped_column(ForeignKey("chat_threads.id", ondelete="CASCADE"))
    chat_request_id: Mapped[str] = mapped_column(ForeignKey("chat_requests.id", ondelete="CASCADE"))
    role: Mapped[str]
    content: Mapped[str] = mapped_column(default="")
    page: Mapped[int]
    selected_text: Mapped[str] = mapped_column(default="")
    status: Mapped[str] = mapped_column(default="completed")
    attempt: Mapped[int] = mapped_column(default=1)
    context_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    provider: Mapped[str] = mapped_column(default="")
    model: Mapped[str] = mapped_column(default="")
    usage: Mapped[dict] = mapped_column(JSON, default=dict)
    error_code: Mapped[str | None]
    created_at: Mapped[str] = mapped_column(default=now)


class AppSettings(Base):
    __tablename__ = "app_settings"
    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    response_style: Mapped[str] = mapped_column(default="step_by_step")
    image_mode: Mapped[str] = mapped_column(default="auto")
    model: Mapped[str] = mapped_column(default="")
    provider: Mapped[str] = mapped_column(default="")
    backup_path: Mapped[str] = mapped_column(default="")
    backup_auto: Mapped[bool] = mapped_column(default=True)
    backup_state: Mapped[dict] = mapped_column(JSON, default=dict)
