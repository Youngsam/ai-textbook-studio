import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { MarkdownContent } from "./MarkdownContent";
import { BackupSettings } from "./BackupSettings";
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  List,
  MessageSquare,
  Minus,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  api,
  streamChat,
  type Book,
  type Message,
  type Page,
  type Outline,
  type Provider,
  type ReadingState,
  type Settings,
} from "./api";
import { PdfView } from "./PdfView";
import { useReadingState } from "./useReadingState";
import { usePanelWidth } from "./usePanelWidth";

export function Reader() {
  const { id } = useParams();
  return <ReaderLoader key={id} id={id!} />;
}

function ReaderLoader({ id }: { id: string }) {
  const book = useQuery({
    queryKey: ["book", id],
    queryFn: () => api<Book>(`/books/${id}`),
  });
  const state = useQuery({
    queryKey: ["state", id],
    queryFn: () => api<ReadingState>(`/books/${id}/state`),
    staleTime: Infinity,
    gcTime: 0,
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<Settings>("/settings"),
  });
  const error = book.error ?? state.error ?? settings.error;
  if (error)
    return (
      <div className="empty">
        <p className="error" role="alert">
          {error.message}
        </p>
        <a href="/">라이브러리로</a>
      </div>
    );
  if (!book.data || !state.data || !settings.data)
    return <div className="empty">학습 공간을 여는 중…</div>;
  return (
    <ReadingRoom
      book={book.data}
      initial={state.data}
      settings={settings.data}
    />
  );
}

const failureLabels: Record<string, string> = {
  provider_failed: "AI 제공자 요청에 실패했습니다.",
  timeout: "응답 제한 시간을 초과했습니다.",
  provider_authentication:
    "API 키 인증에 실패했습니다. 서버 설정을 확인해 주세요.",
  provider_rate_limit:
    "API 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
  images_unsupported: "현재 모델은 이미지 입력이 비활성화되어 있습니다.",
  image_required: "텍스트가 없는 페이지입니다. 이미지 첨부를 허용해 주세요.",
  context_too_large: "질문과 선택 문구가 너무 깁니다. 길이를 줄여 주세요.",
  server_restarted: "서버 재시작으로 답변이 중단되었습니다.",
  connection_closed: "연결이 종료되어 답변이 중단되었습니다.",
};

function ReadingRoom({
  book,
  initial,
  settings,
}: {
  book: Book;
  initial: ReadingState;
  settings: Settings;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { state, change, status, flush } = useReadingState(book.id, initial);
  const panel = usePanelWidth();
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = Number(
        localStorage.getItem("textbook-studio.chat-font-size"),
      );
      return Number.isFinite(saved) && saved >= 10 && saved <= 24 ? saved : 12;
    } catch {
      return 12;
    }
  });
  function resizeText(next: number) {
    const size = Math.max(10, Math.min(24, next));
    setFontSize(size);
    try {
      localStorage.setItem("textbook-studio.chat-font-size", String(size));
    } catch {
      /* Storage can be disabled. */
    }
  }
  const [selection, setSelection] = useState("");
  const [question, setQuestion] = useState("");
  const [preferences, setPreferences] = useState({
    provider: settings.provider,
    image_mode: settings.image_mode,
    response_style: settings.response_style,
    model: settings.model,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [modelDraft, setModelDraft] = useState({
    provider: settings.provider,
    model: settings.model,
  });
  const [testingModel, setTestingModel] = useState(false);
  const [modelResult, setModelResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [showOutline, setShowOutline] = useState(false);
  const outline = useQuery({
    queryKey: ["outline", book.id],
    queryFn: () => api<Outline>(`/books/${book.id}/outline`),
    enabled: showOutline,
    staleTime: Infinity,
  });
  const outlineControl = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!showOutline) return;
    const close = (event: PointerEvent) => {
      if (!outlineControl.current?.contains(event.target as Node))
        setShowOutline(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowOutline(false);
        outlineControl.current?.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [showOutline]);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Message | null>(null);
  const [extraMessages, setExtraMessages] = useState<Message[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const chatBottom = useRef<HTMLDivElement>(null);
  const history = useQuery({
    queryKey: ["messages", book.id],
    queryFn: () => api<Page<Message>>(`/books/${book.id}/messages`),
    refetchInterval: (query) =>
      query.state.data?.items.some((m) =>
        ["pending", "streaming"].includes(m.status),
      ) && !busy
        ? 1500
        : false,
  });
  const messages = [...extraMessages, ...(history.data?.items ?? [])];
  const activeRemote = history.data?.items.some((m) =>
    ["pending", "streaming"].includes(m.status),
  );

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    chatBottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [draft?.content, history.data?.items.length]);

  function pageTo(page: number) {
    change({
      ...state,
      page: Math.min(book.page_count, Math.max(1, page)),
      scroll_offset: 0,
    });
    setSelection("");
    window.getSelection()?.removeAllRanges();
  }

  async function savePreferences(next: typeof preferences) {
    if (savingPreferences) return;
    setSavingPreferences(true);
    try {
      const saved = await api<Settings>("/settings", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      setPreferences({
        provider: saved.provider,
        image_mode: saved.image_mode,
        response_style: saved.response_style,
        model: saved.model,
      });
      await client.invalidateQueries({ queryKey: ["settings"] });
      return true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingPreferences(false);
    }
  }

  async function testModel() {
    setTestingModel(true);
    setModelResult(null);
    try {
      const result = await api<{ ok: boolean; message: string }>(
        "/settings/test",
        {
          method: "POST",
          body: JSON.stringify({
            ...modelDraft,
            model: modelDraft.model.trim(),
          }),
        },
      );
      setModelResult(result);
    } catch (e) {
      setModelResult({ ok: false, message: (e as Error).message });
    } finally {
      setTestingModel(false);
    }
  }

  async function send(event?: FormEvent, retryId?: string) {
    event?.preventDefault();
    if (busy || (!retryId && !question.trim())) return;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    const requestId = crypto.randomUUID();
    const captured = {
      request_id: requestId,
      question: question.trim(),
      page: state.page,
      selected_text: selection,
      ...preferences,
    };
    try {
      await streamChat(
        `/books/${book.id}/chat${retryId ? `/${retryId}/retry` : ""}`,
        retryId ? undefined : captured,
        controller.signal,
        (event) => {
          const data = event.data;
          if (event.event === "accepted") {
            setQuestion("");
            setDraft({
              id: String(data.assistant_message_id),
              role: "assistant",
              content: "",
              page: captured.page,
              selected_text: selection,
              status: "streaming",
              request_id: requestId,
              error_code: null,
              context_snapshot: {},
            });
            void history.refetch();
          } else if (event.event === "delta")
            setDraft((previous) =>
              previous
                ? { ...previous, content: previous.content + String(data.text) }
                : null,
            );
          else if (event.event === "context")
            setDraft((previous) =>
              previous
                ? {
                    ...previous,
                    page: Number(data.page),
                    context_snapshot: data,
                  }
                : null,
            );
          else if (event.event === "failed")
            setError(
              failureLabels[String(data.code)] ??
                "답변을 완료하지 못했습니다. 다시 시도해 주세요.",
            );
        },
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setBusy(false);
      await history.refetch();
      setDraft(null);
      abort.current = null;
    }
  }

  async function older() {
    const cursor = olderCursor ?? history.data?.next_cursor;
    if (!cursor) return;
    setLoadingOlder(true);
    try {
      const page = await api<Page<Message>>(
        `/books/${book.id}/messages?before=${cursor}`,
      );
      setExtraMessages((previous) => [...page.items, ...previous]);
      setOlderCursor(page.next_cursor ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }

  const visibleMessages = draft
    ? messages.filter((m) => m.id !== draft.id)
    : messages;
  return (
    <div className="reader-shell">
      <header className="reader-header">
        <button
          className="back-button"
          onClick={async () => {
            if (await flush()) {
              await client.invalidateQueries({ queryKey: ["books"] });
              navigate("/");
            }
          }}
        >
          <ArrowLeft size={18} />
          <span>내 서재</span>
        </button>
        <span className="header-divider" />
        <BookOpen size={18} />
        <div className="reader-title">
          <strong>{book.title}</strong>
          <small>{book.author || "학습 프로젝트"}</small>
        </div>
        <div className="reader-save" role="status">
          <i className={status === "저장 실패" ? "failed-dot" : ""} />
          {status}
          {status === "저장 실패" && (
            <button onClick={() => flush()}>재시도</button>
          )}
        </div>
      </header>
      <main
        className="workspace"
        ref={panel.container}
        style={{ "--chat-panel-width": `${panel.width}px` } as CSSProperties}
      >
        <section className="reader-panel" aria-label="PDF 독서 영역">
          <div className="reader-toolbar">
            <div className="page-controls">
              <button
                className="icon-button"
                aria-label="이전 페이지"
                disabled={state.page <= 1}
                onClick={() => pageTo(state.page - 1)}
              >
                <ChevronLeft size={18} />
              </button>
              <input
                aria-label="현재 페이지"
                type="number"
                min={1}
                max={book.page_count}
                value={state.page}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (value >= 1) pageTo(value);
                }}
              />
              <span>/ {book.page_count}</span>
              <button
                className="icon-button"
                aria-label="다음 페이지"
                disabled={state.page >= book.page_count}
                onClick={() => pageTo(state.page + 1)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
            <details
              className="outline-control"
              ref={outlineControl}
              open={showOutline}
            >
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  setShowOutline(!showOutline);
                }}
                aria-expanded={showOutline}
                aria-controls="pdf-outline"
              >
                <List size={16} />
                <span>목차</span>
              </summary>
              <nav
                id="pdf-outline"
                className="outline-menu"
                aria-label="PDF 목차"
              >
                <strong>목차 바로가기</strong>
                {outline.isPending && <p role="status">목차를 불러오는 중…</p>}
                {outline.isError && (
                  <p role="alert">
                    {outline.error.message}{" "}
                    <button onClick={() => outline.refetch()}>재시도</button>
                  </p>
                )}
                {outline.data?.items.length === 0 && (
                  <p>
                    이 PDF에는 내장 목차가 없습니다. 왼쪽 페이지 번호로 이동할
                    수 있습니다.
                  </p>
                )}
                {outline.data?.items.map((item, index) => (
                  <button
                    key={index}
                    style={{
                      paddingLeft: `${12 + Math.min(item.level - 1, 8) * 14}px`,
                    }}
                    onClick={() => {
                      pageTo(item.page);
                      setShowOutline(false);
                      outlineControl.current?.querySelector("summary")?.focus();
                    }}
                  >
                    <span>{item.title}</span>
                    <small>{item.page}쪽</small>
                  </button>
                ))}
              </nav>
            </details>
            <div className="zoom-controls">
              <button
                className="icon-button"
                aria-label="축소"
                disabled={state.zoom <= 0.5}
                onClick={() =>
                  change({ ...state, zoom: Math.max(0.5, state.zoom - 0.1) })
                }
              >
                <Minus size={16} />
              </button>
              <span>{Math.round(state.zoom * 100)}%</span>
              <button
                className="icon-button"
                aria-label="확대"
                disabled={state.zoom >= 3}
                onClick={() =>
                  change({ ...state, zoom: Math.min(3, state.zoom + 0.1) })
                }
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
          <div className="pdf-stage">
            <PdfView
              id={book.id}
              state={state}
              onScroll={(offset) => change({ ...state, scroll_offset: offset })}
              onSelection={setSelection}
            />
            <button
              className="page-side previous"
              aria-label="PDF 왼쪽 이전 페이지"
              title="이전 페이지"
              disabled={state.page <= 1}
              onClick={() => pageTo(state.page - 1)}
            >
              <ChevronLeft size={26} />
            </button>
            <button
              className="page-side next"
              aria-label="PDF 오른쪽 다음 페이지"
              title="다음 페이지"
              disabled={state.page >= book.page_count}
              onClick={() => pageTo(state.page + 1)}
            >
              <ChevronRight size={26} />
            </button>
          </div>
          <div className="reader-footer">
            <span>PDF · {state.page}쪽</span>
            <progress value={state.page} max={book.page_count} />
            <span>{Math.round((state.page / book.page_count) * 100)}%</span>
          </div>
        </section>
        <div
          className="panel-resizer"
          {...panel.separator}
          title="드래그해서 너비 조절 · 두 번 클릭하면 기본 너비"
        />
        <aside
          id="learning-assistant"
          className="chat-panel"
          style={{ "--chat-font-size": `${fontSize}px` } as CSSProperties}
          aria-label="AI 학습 도우미"
        >
          <div className="chat-header">
            <span className="ai-mark">
              <Sparkles size={18} />
            </span>
            <div className="chat-heading">
              <strong>학습 도우미</strong>
            </div>
            <div className="chat-header-actions">
              <div
                className="chat-text-controls"
                role="group"
                aria-label="글자 크기"
              >
                <button
                  className="icon-button"
                  aria-label="도우미 글자 축소"
                  title="글자 작게"
                  disabled={fontSize <= 10}
                  onClick={() => resizeText(fontSize - 1)}
                >
                  <Minus size={14} />
                </button>
                <output aria-label="도우미 글자 크기" aria-live="polite">
                  {fontSize}px
                </output>
                <button
                  className="icon-button"
                  aria-label="도우미 글자 확대"
                  title="글자 크게"
                  disabled={fontSize >= 24}
                  onClick={() => resizeText(fontSize + 1)}
                >
                  <Plus size={14} />
                </button>
                <button
                  className="icon-button"
                  aria-label="도우미 글자 크기 초기화"
                  title="글자 크기 초기화"
                  onClick={() => resizeText(12)}
                >
                  <RotateCcw size={13} />
                </button>
              </div>
              <button
                className="icon-button"
                aria-label="AI 설정"
                title="AI 설정"
                aria-expanded={showSettings}
                onClick={() => setShowSettings(!showSettings)}
              >
                <Settings2 size={18} />
              </button>
            </div>
          </div>
          {showSettings && (
            <section className="settings-panel">
              <strong>AI 설정</strong>
              <p>
                현재: {settings.provider} · {settings.model || "모델 미설정"}
              </p>
              <label>
                제공업체
                <select
                  aria-label="제공업체"
                  value={modelDraft.provider}
                  disabled={
                    busy || activeRemote || savingPreferences || testingModel
                  }
                  onChange={(event) => {
                    setModelDraft({
                      provider: event.target.value as Provider,
                      model: "",
                    });
                    setModelResult(null);
                  }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="gemini">Gemini (Google)</option>
                  <option value="openrouter">OpenRouter</option>
                  {settings.provider === "fake" && (
                    <option value="fake">테스트 모드</option>
                  )}
                </select>
              </label>
              <label>
                설명 모델
                <input
                  value={modelDraft.model}
                  maxLength={200}
                  placeholder="모델 ID를 입력하세요"
                  disabled={
                    busy || activeRemote || savingPreferences || testingModel
                  }
                  onChange={(event) => {
                    setModelDraft({ ...modelDraft, model: event.target.value });
                    setModelResult(null);
                  }}
                />
              </label>
              <div className="model-actions">
                <button
                  disabled={
                    !modelDraft.model.trim() ||
                    modelDraft.provider === "fake" ||
                    testingModel ||
                    savingPreferences
                  }
                  onClick={testModel}
                >
                  {testingModel ? "테스트 중…" : "연결 테스트"}
                </button>
                <button
                  disabled={
                    !modelDraft.model.trim() ||
                    busy ||
                    activeRemote ||
                    savingPreferences ||
                    testingModel
                  }
                  onClick={async () => {
                    if (
                      await savePreferences({
                        ...preferences,
                        ...modelDraft,
                        model: modelDraft.model.trim(),
                      })
                    )
                      setModelResult({
                        ok: true,
                        message: "제공업체와 모델을 저장했습니다.",
                      });
                  }}
                >
                  설정 저장
                </button>
              </div>
              <p>
                테스트는 책 내용 없이 짧은 요청을 보내며 API 사용량이 발생할 수
                있습니다. API 키는 서버 .env에 설정합니다.
              </p>
              {modelResult && (
                <div
                  className={modelResult.ok ? "model-success" : "error"}
                  role="status"
                >
                  {modelResult.message}
                </div>
              )}
              <label>
                응답 스타일
                <select
                  value={preferences.response_style}
                  disabled={savingPreferences}
                  onChange={(e) =>
                    savePreferences({
                      ...preferences,
                      response_style: e.target
                        .value as Settings["response_style"],
                    })
                  }
                >
                  <option value="step_by_step">단계별 설명</option>
                  <option value="concise">간결한 설명</option>
                </select>
              </label>
              <label>
                페이지 이미지
                <select
                  value={preferences.image_mode}
                  disabled={savingPreferences}
                  onChange={(e) =>
                    savePreferences({
                      ...preferences,
                      image_mode: e.target.value as Settings["image_mode"],
                    })
                  }
                >
                  <option value="auto">자동 · 스캔 페이지</option>
                  <option value="always">항상 첨부 · 도표·수식</option>
                  <option value="never">첨부하지 않음</option>
                </select>
              </label>
              <BackupSettings />
            </section>
          )}
          {!settings.llm_configured && (
            <div className="config-notice">
              AI 설정에서 제공업체와 모델명을 저장하고, 해당 API 키를 서버
              .env에 지정해 주세요. PDF 읽기는 계속 사용할 수 있습니다.
            </div>
          )}
          {settings.provider === "fake" && (
            <div className="config-notice">
              테스트 모드입니다. 외부 API를 호출하지 않습니다.
            </div>
          )}
          <div className="messages">
            <button
              className="load-more"
              hidden={
                !(olderCursor === null
                  ? history.data?.next_cursor
                  : olderCursor)
              }
              disabled={loadingOlder}
              onClick={older}
            >
              {loadingOlder ? "불러오는 중…" : "이전 대화 보기"}
            </button>
            {history.isError && (
              <p className="error" role="alert">
                {history.error.message}
                <button onClick={() => history.refetch()}>재시도</button>
              </p>
            )}
            {!messages.length && !draft && (
              <div className="chat-welcome">
                <div className="welcome-symbol">
                  <MessageSquare size={26} strokeWidth={1.4} />
                </div>
                <div className="eyebrow">A LITTLE CLARITY, EVERY PAGE</div>
                <h2>이해가 깊어지는 대화</h2>
                <p>
                  어려운 문장이나 수식이 있나요?
                  <br />
                  현재 페이지를 바탕으로 함께 풀어볼게요.
                </p>
                <button
                  onClick={() =>
                    setQuestion("현재 페이지의 핵심 개념을 단계별로 설명해 줘.")
                  }
                >
                  <Sparkles size={14} /> 이 페이지의 핵심 개념 설명하기
                </button>
              </div>
            )}
            {[...visibleMessages, ...(draft ? [draft] : [])].map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-label">
                  {message.role === "user" ? "나의 질문" : "학습 도우미"}
                  <span>
                    PDF {message.page}쪽
                    {message.context_snapshot.image_attached ? " · 이미지" : ""}
                  </span>
                </div>
                {message.selected_text && message.role === "user" && (
                  <blockquote>{message.selected_text}</blockquote>
                )}
                <div className="markdown">
                  <MarkdownContent>
                    {message.content ||
                      (message.status === "pending" ||
                      message.status === "streaming"
                        ? "문맥을 살펴보는 중…"
                        : "저장된 답변이 없습니다.")}
                  </MarkdownContent>
                </div>
                {message.context_snapshot.truncated && (
                  <small className="muted">
                    긴 페이지의 본문 일부가 생략되었습니다.
                  </small>
                )}
                {["failed", "interrupted"].includes(message.status) && (
                  <div className="message-error">
                    <span>
                      {failureLabels[message.error_code ?? ""] ??
                        "답변이 완료되지 않았습니다."}
                    </span>
                    <button
                      disabled={
                        busy || activeRemote || !settings.llm_configured
                      }
                      onClick={() => send(undefined, message.request_id)}
                    >
                      답변 재시도
                    </button>
                  </div>
                )}
              </article>
            ))}
            <div ref={chatBottom} />
          </div>
          <div className="composer">
            <div className="context-chip">
              <span>
                <BookOpen size={13} /> PDF {state.page}쪽 ·{" "}
                {preferences.image_mode === "always"
                  ? "이미지 첨부"
                  : preferences.image_mode === "never"
                    ? "텍스트 문맥"
                    : "이미지 자동"}
              </span>
            </div>
            {selection && (
              <div className="selection-chip">
                <span>“{selection}”</span>
                <button
                  className="icon-button"
                  aria-label="선택 문구 해제"
                  onClick={() => setSelection("")}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <form onSubmit={send}>
              <textarea
                aria-label="질문"
                placeholder="이 페이지에서 궁금한 점을 질문하세요…"
                value={question}
                maxLength={8000}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-bottom">
                <small>
                  {busy
                    ? "답변을 작성하고 있어요"
                    : "Enter 전송 · Shift+Enter 줄바꿈"}
                </small>
                {busy ? (
                  <button
                    type="button"
                    className="send-button"
                    aria-label="답변 중단"
                    onClick={() => abort.current?.abort()}
                  >
                    <Square size={15} />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    aria-label="질문 보내기"
                    disabled={
                      !question.trim() ||
                      !settings.llm_configured ||
                      activeRemote
                    }
                  >
                    <ArrowUp size={18} />
                  </button>
                )}
              </div>
            </form>
            <p className="privacy-note">
              질문 시 현재 페이지·선택 문구와 설정에 따른 이미지가 AI 제공자에게
              전송됩니다. AI 설명은 원문과 함께 확인하세요.
            </p>
          </div>
        </aside>
      </main>
    </div>
  );
}
