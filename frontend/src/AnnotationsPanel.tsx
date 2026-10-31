import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  Highlighter,
  MessageSquare,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  annotationColors,
  type Annotation,
  type AnnotationColor,
  type TextSelection,
} from "./annotations";

export function ColorPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: AnnotationColor;
  onChange: (color: AnnotationColor) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="annotation-colors"
      role="group"
      aria-label="하이라이트 색상"
    >
      {Object.entries(annotationColors).map(([color, { label, fill }]) => (
        <button
          key={color}
          type="button"
          className="annotation-swatch"
          style={{ background: fill }}
          aria-label={`${label} 하이라이트`}
          aria-pressed={value === color}
          disabled={disabled}
          onClick={() => onChange(color as AnnotationColor)}
        >
          {value === color && <Check size={14} />}
        </button>
      ))}
    </div>
  );
}

export type AnnotationDraft = {
  selection: TextSelection;
  existing?: Annotation;
  color: AnnotationColor;
};
export function AnnotationsPanel({
  open,
  items,
  loading,
  loadError,
  retry,
  draft,
  setDraft,
  busy,
  error,
  onSave,
  onDelete,
  onNavigate,
  onClose,
}: {
  open: boolean;
  items: Annotation[];
  loading: boolean;
  loadError: string;
  retry: () => void;
  draft: AnnotationDraft | null;
  setDraft: (draft: AnnotationDraft | null) => void;
  busy: boolean;
  error: string;
  onSave: (
    selection: TextSelection,
    color: AnnotationColor,
    note: string,
    existing?: Annotation,
  ) => Promise<boolean>;
  onDelete: (annotation: Annotation) => Promise<boolean>;
  onNavigate: (annotation: Annotation) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [colorFilter, setColorFilter] = useState("all");
  const [sort, setSort] = useState("page");
  const [note, setNote] = useState("");
  const [color, setColor] = useState<AnnotationColor>("yellow");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    if (draft) textarea.current?.focus();
    else heading.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        closeRef.current();
        document
          .querySelector<HTMLButtonElement>(
            '[aria-controls="reader-annotations"]',
          )
          ?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, draft, busy]);
  useEffect(() => {
    setNote(draft?.existing?.note ?? "");
    setColor(draft?.color ?? "yellow");
    setConfirmDelete(false);
    if (draft) textarea.current?.focus();
  }, [draft]);
  const visible = items
    .filter((item) => {
      const query = search.trim().toLocaleLowerCase();
      return (
        (filter === "all" ||
          (filter === "notes" ? !!item.note.trim() : !item.note.trim())) &&
        (colorFilter === "all" || item.color === colorFilter) &&
        (!query ||
          `${item.selected_text} ${item.note} ${item.page}쪽`
            .toLocaleLowerCase()
            .includes(query))
      );
    })
    .sort((a, b) =>
      sort === "recent"
        ? b.updated_at.localeCompare(a.updated_at)
        : a.page - b.page || a.rects[0].y - b.rects[0].y,
    );
  return (
    <aside className="annotations-panel" aria-label="내 기록">
      <div className="annotations-heading">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            <Highlighter size={17} /> 내 기록 <span>{items.length}</span>
          </h2>
          <p>읽으며 남긴 생각을 한곳에</p>
        </div>
        <button
          className="icon-button"
          aria-label="내 기록 닫기"
          disabled={busy}
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      {draft ? (
        <form
          className="annotation-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await onSave(draft.selection, color, note, draft.existing))
              setDraft(null);
          }}
        >
          <button
            type="button"
            className="annotation-back"
            disabled={busy}
            onClick={() => setDraft(null)}
          >
            <ChevronLeft size={14} /> 기록 목록
          </button>
          <div className="annotation-editor-title">
            <strong>{draft.existing ? "기록 편집" : "주석 남기기"}</strong>
            <span>PDF {draft.selection.page}쪽</span>
          </div>
          <blockquote style={{ borderColor: annotationColors[color].fill }}>
            {draft.selection.selected_text}
          </blockquote>
          <label>
            하이라이트 색상
            <ColorPicker value={color} onChange={setColor} disabled={busy} />
          </label>
          <label>
            나의 주석
            <textarea
              aria-label="나의 주석"
              ref={textarea}
              value={note}
              maxLength={10000}
              rows={7}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
              placeholder="떠오른 생각이나 다시 살펴볼 내용을 남겨 보세요."
            />
          </label>
          <small className="annotation-editor-hint">
            주석을 비워 두면 하이라이트만 저장됩니다.
          </small>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy} type="submit">
            <Check size={15} />
            {busy ? "저장 중…" : "기록 저장"}
          </button>
          {draft.existing &&
            (confirmDelete ? (
              <div className="annotation-delete-confirm">
                <p>이 하이라이트와 주석을 삭제할까요?</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    if (await onDelete(draft.existing!)) setDraft(null);
                  }}
                >
                  삭제
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  취소
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="annotation-delete"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={14} /> 기록 삭제
              </button>
            ))}
        </form>
      ) : (
        <>
          <div className="annotations-filters">
            <div className="annotation-search">
              <Search size={15} />
              <input
                aria-label="기록 검색"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="문구, 주석, 페이지 검색"
              />
            </div>
            <div
              className="annotation-tabs"
              role="group"
              aria-label="기록 종류"
            >
              {[
                ["all", "전체"],
                ["highlights", "하이라이트"],
                ["notes", "주석"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="annotation-filter-row">
              <select
                aria-label="기록 색상 필터"
                value={colorFilter}
                onChange={(e) => setColorFilter(e.target.value)}
              >
                <option value="all">모든 색상</option>
                {Object.entries(annotationColors).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="기록 정렬"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="page">페이지순</option>
                <option value="recent">최근 수정순</option>
              </select>
            </div>
          </div>
          <div className="annotations-list">
            {loading && <p role="status">기록을 불러오는 중…</p>}
            {loadError && (
              <p className="error" role="alert">
                {loadError} <button onClick={retry}>재시도</button>
              </p>
            )}
            {!loading && !loadError && !visible.length && (
              <div className="annotations-empty">
                <Highlighter size={30} />
                <strong>
                  {items.length
                    ? "일치하는 기록이 없습니다"
                    : "기억하고 싶은 문장을 담아 보세요"}
                </strong>
                <p>
                  {items.length
                    ? "검색어나 필터를 바꿔 보세요."
                    : "본문의 텍스트를 선택해 색을 입히거나 주석을 남길 수 있습니다."}
                </p>
              </div>
            )}
            {visible.map((item) => (
              <article
                key={item.id}
                className="annotation-card"
                style={
                  {
                    "--annotation-color": annotationColors[item.color].fill,
                  } as React.CSSProperties
                }
              >
                <div className="annotation-card-meta">
                  <button onClick={() => onNavigate(item)}>
                    PDF {item.page}쪽 <span>원문 보기 ↗</span>
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`PDF ${item.page}쪽 기록 편집`}
                    onClick={() =>
                      setDraft({
                        selection: item,
                        existing: item,
                        color: item.color,
                      })
                    }
                  >
                    <Pencil size={14} />
                  </button>
                </div>
                <button
                  className="annotation-quote"
                  onClick={() => onNavigate(item)}
                >
                  {item.selected_text}
                </button>
                {item.note && (
                  <p className="annotation-note">
                    <MessageSquare size={13} />
                    <span>{item.note}</span>
                  </p>
                )}
                <small>
                  {new Date(item.updated_at).toLocaleDateString("ko-KR")}
                </small>
              </article>
            ))}
          </div>
          {error && (
            <p className="error annotation-panel-error" role="alert">
              {error}
            </p>
          )}
          <div className="annotations-footnote">
            문구를 누르면 원문 위치로 이동합니다.
          </div>
        </>
      )}
    </aside>
  );
}
