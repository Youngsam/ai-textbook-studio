import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  BookOpen,
  Grid2x2,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, type Book, type Page } from "./api";
import { BackupSettings } from "./BackupSettings";

type ViewMode = "large" | "compact" | "list";
const VIEW_KEY = "library-view";
const VIEW_OPTIONS: { mode: ViewMode; label: string; icon: typeof List }[] = [
  { mode: "large", label: "큰 카드", icon: LayoutGrid },
  { mode: "compact", label: "작은 카드", icon: Grid2x2 },
  { mode: "list", label: "목록", icon: List },
];

function loadView(): ViewMode {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "large" || saved === "compact" || saved === "list")
      return saved;
  } catch {
    /* storage unavailable */
  }
  return "large";
}

export function Library() {
  const client = useQueryClient();
  const books = useInfiniteQuery({
    queryKey: ["books"],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<Page<Book>>(`/books${pageParam ? `?before=${pageParam}` : ""}`),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const [view, setView] = useState<ViewMode>(loadView);
  const [adding, setAdding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Book | null>(null);
  const [editing, setEditing] = useState<Book | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editAuthor, setEditAuthor] = useState("");
  const items = books.data?.pages.flatMap((page) => page.items) ?? [];

  function changeView(mode: ViewMode) {
    setView(mode);
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      /* storage unavailable */
    }
  }

  function openAdd() {
    setError("");
    setAdding(true);
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || !title.trim() || busy) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    form.append("title", title);
    form.append("author", author);
    try {
      await api<Book>("/books", { method: "POST", body: form });
      await client.invalidateQueries({ queryKey: ["books"] });
      setAdding(false);
      setTitle("");
      setAuthor("");
      setFile(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openEdit(book: Book) {
    setError("");
    setEditTitle(book.title);
    setEditAuthor(book.author);
    setEditing(book);
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing || !editTitle.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api<Book>(`/books/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editTitle, author: editAuthor }),
      });
      setEditing(null);
      await client.invalidateQueries({ queryKey: ["books"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/books/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      await client.invalidateQueries({ queryKey: ["books"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="library-shell">
      <header className="brand-header">
        <Link className="brand" to="/">
          <span className="brand-mark">
            <BookOpen size={20} />
          </span>{" "}
          Textbook Studio
          <span className="brand-caption">PERSONAL LEARNING SPACE</span>
        </Link>
        <button onClick={() => setShowSettings(true)} aria-label="설정 · 백업">
          <Settings2 size={18} /> 설정
        </button>
      </header>
      <main className="library-main">
        <div className="library-heading">
          <div>
            <div className="eyebrow">YOUR KNOWLEDGE, CONNECTED</div>
            <h1>한 권씩, 더 깊이.</h1>
            <p>읽던 곳에서 이어 읽고, 궁금한 순간 바로 질문하세요.</p>
          </div>
          <button
            className="primary"
            onClick={() => {
              setError("");
              setAdding(true);
            }}
          >
            <Plus size={18} /> 새 책 추가
          </button>
        </div>
        <div className="section-heading">
          <h2>
            내 서재 <span>{items.length}</span>
          </h2>
          <div className="section-tools">
            <span>최근 읽은 순</span>
            <div className="view-toggle" role="group" aria-label="보기 방식">
              {VIEW_OPTIONS.map(({ mode, label, icon: Icon }) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={view === mode}
                  aria-label={label}
                  title={label}
                  onClick={() => changeView(mode)}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
          </div>
        </div>
        {error && !adding && !deleting && !editing && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {books.isPending ? (
          <div className="empty">서재를 불러오는 중…</div>
        ) : books.isError ? (
          <div className="empty">
            <p role="alert">{books.error.message}</p>
            <button onClick={() => books.refetch()}>다시 시도</button>
          </div>
        ) : view === "list" ? (
          <ul className="book-list">
            {items.map((book, index) => (
              <li className="book-row" key={book.id}>
                <Link
                  to={`/books/${book.id}`}
                  className={`row-cover cover-${index % 4}`}
                  aria-hidden="true"
                  tabIndex={-1}
                >
                  <BookOpen size={18} strokeWidth={1.4} />
                </Link>
                <Link className="row-title" to={`/books/${book.id}`}>
                  <strong>{book.title}</strong>
                  <small>{book.author || "나의 학습 프로젝트"}</small>
                </Link>
                <div className="row-progress">
                  <progress value={book.current_page} max={book.page_count} />
                  <span>
                    {book.current_page} / {book.page_count}쪽 · {book.progress}%
                  </span>
                </div>
                <span className="row-date">
                  {new Date(book.last_opened_at).toLocaleDateString("ko-KR")}
                </span>
                <button
                  className="icon-button"
                  aria-label={`${book.title} 편집`}
                  onClick={() => openEdit(book)}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`${book.title} 삭제`}
                  onClick={() => {
                    setError("");
                    setDeleting(book);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
            <li>
              <button className="row-add" onClick={openAdd}>
                <Plus size={16} /> 새 책 추가
              </button>
            </li>
          </ul>
        ) : (
          <div className={`book-grid ${view === "compact" ? "compact" : ""}`}>
            {items.map((book, index) => (
              <article className="book-card" key={book.id}>
                <Link
                  to={`/books/${book.id}`}
                  className={`book-cover cover-${index % 4}`}
                >
                  <div className="cover-top">
                    LEARNING PROJECT{" "}
                    <span>{String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <BookOpen size={32} strokeWidth={1.3} />
                  <h3>{book.title}</h3>
                  <div className="cover-bottom">
                    {book.author || "나의 학습 프로젝트"}
                    <ArrowUpRight size={20} />
                  </div>
                </Link>
                <div className="book-details">
                  <Link to={`/books/${book.id}`}>{book.title}</Link>
                  <span className="book-actions">
                    <button
                      className="icon-button"
                      aria-label={`${book.title} 편집`}
                      onClick={() => openEdit(book)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`${book.title} 삭제`}
                      onClick={() => {
                        setError("");
                        setDeleting(book);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </span>
                </div>
                <div className="book-progress">
                  <span>
                    {book.current_page} / {book.page_count}쪽
                  </span>
                  <span>{book.progress}%</span>
                </div>
                <progress value={book.current_page} max={book.page_count} />
                <div className="last-opened">
                  {new Date(book.last_opened_at).toLocaleDateString("ko-KR")}{" "}
                  열람
                </div>
              </article>
            ))}
            <button className="add-card" onClick={openAdd}>
              <span>
                <Plus size={24} />
              </span>
              <strong>새로운 배움을 시작하세요</strong>
              <small>PDF를 추가해 나만의 학습 공간 만들기</small>
            </button>
          </div>
        )}
        {books.hasNextPage && (
          <button className="load-more" onClick={() => books.fetchNextPage()}>
            더 불러오기
          </button>
        )}
        <footer className="library-footer">
          <BookOpen size={16} />
          <span>
            책과 학습 기록은 이 서버에 보관됩니다. 질문할 때 선택한 문맥이 AI
            제공자에게 전송됩니다.
          </span>
        </footer>
      </main>
      {showSettings && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="backup-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="닫기"
              onClick={() => setShowSettings(false)}
            >
              <X />
            </button>
            <h2 id="backup-title">설정</h2>
            <BackupSettings />
          </section>
        </div>
      )}
      {adding && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-title"
            className="modal"
          >
            <button
              className="modal-close icon-button"
              aria-label="닫기"
              disabled={busy}
              onClick={() => setAdding(false)}
            >
              <X />
            </button>
            <div className="eyebrow">NEW LEARNING PROJECT</div>
            <h2 id="upload-title">서재에 책 추가</h2>
            <p>PDF 한 권이 하나의 학습 프로젝트가 됩니다.</p>
            <form onSubmit={upload}>
              <label className="file-picker">
                <Upload />
                <strong>{file?.name ?? "PDF 파일 선택"}</strong>
                <small>최대 500 MiB · 암호화되지 않은 PDF</small>
                <input
                  aria-label="PDF 파일"
                  type="file"
                  accept="application/pdf,.pdf"
                  required
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.files?.[0] ?? null;
                    setFile(next);
                    if (next && !title)
                      setTitle(next.name.replace(/\.pdf$/i, ""));
                  }}
                />
              </label>
              <label>
                책 제목
                <input
                  autoFocus
                  value={title}
                  maxLength={300}
                  required
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                저자 <span className="muted">선택</span>
                <input
                  value={author}
                  maxLength={300}
                  disabled={busy}
                  onChange={(e) => setAuthor(e.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <button
                className="primary full-width"
                disabled={busy || !file || !title.trim()}
              >
                {busy ? "PDF 분석 중…" : "학습 프로젝트 만들기"}
              </button>
            </form>
          </section>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-title"
            className="modal"
          >
            <button
              className="modal-close icon-button"
              aria-label="닫기"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              <X />
            </button>
            <h2 id="edit-title">책 정보 편집</h2>
            <form onSubmit={saveEdit}>
              <label>
                책 제목
                <input
                  autoFocus
                  value={editTitle}
                  maxLength={300}
                  required
                  disabled={busy}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              </label>
              <label>
                저자 <span className="muted">선택</span>
                <input
                  value={editAuthor}
                  maxLength={300}
                  disabled={busy}
                  onChange={(e) => setEditAuthor(e.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <button
                className="primary full-width"
                disabled={busy || !editTitle.trim()}
              >
                {busy ? "저장 중…" : "저장"}
              </button>
            </form>
          </section>
        </div>
      )}
      {deleting && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            className="modal"
          >
            <h2 id="delete-title">책을 삭제하시겠습니까?</h2>
            <p>
              “{deleting.title}”의 원본 PDF와 모든 대화·독서 기록이 삭제됩니다.
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setDeleting(null)}>
                취소
              </button>
              <button className="danger" disabled={busy} onClick={remove}>
                {busy ? "삭제 중…" : "모두 삭제"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
