import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowUpRight, BookOpen, Plus, Trash2, Upload, X } from "lucide-react";
import { api, type Book, type Page } from "./api";

export function Library() {
  const client = useQueryClient();
  const books = useInfiniteQuery({
    queryKey: ["books"],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<Page<Book>>(`/books${pageParam ? `?before=${pageParam}` : ""}`),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Book | null>(null);
  const items = books.data?.pages.flatMap((page) => page.items) ?? [];

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
        <span className="local-badge">
          <i /> 개인 라이브러리
        </span>
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
          <span>최근 읽은 순</span>
        </div>
        {error && !adding && !deleting && (
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
        ) : (
          <div className="book-grid">
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
            <button
              className="add-card"
              onClick={() => {
                setError("");
                setAdding(true);
              }}
            >
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
