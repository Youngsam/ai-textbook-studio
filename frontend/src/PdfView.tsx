import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { ArrowLeft, MessageSquare, Minus, Plus, X } from "lucide-react";
import { api, type CropAttachment, type ReadingState } from "./api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AnnotationsPanel,
  ColorPicker,
  type AnnotationDraft,
} from "./AnnotationsPanel";
import {
  type Annotation,
  type AnnotationColor,
  type TextSelection,
} from "./annotations";
import {
  resolveReference,
  type PdfLocation,
  type PdfRequest,
  type ReferenceTarget,
} from "./pdfReferences";

import { PdfPage, type PageHandle } from "./PdfPage";

GlobalWorkerOptions.workerSrc = workerUrl;
type Preview = {
  target: ReferenceTarget;
  title: string;
  source: HTMLElement;
  request: PdfRequest;
  state: ReadingState;
};

export function PdfView({
  id,
  state,
  onScroll,
  onSelection,
  onNavigate,
  showAnnotations,
  onShowAnnotations,
  cropMode,
  onCrop,
  onCropCancel,
}: {
  id: string;
  cropMode: boolean;
  onCrop: (crop: CropAttachment) => void;
  onCropCancel: () => void;
  showAnnotations: boolean;
  onShowAnnotations: (value: boolean) => void;
  state: ReadingState;
  onScroll: (offset: number) => void;
  onSelection: (value: string) => void;
  onNavigate: (state: ReadingState) => void;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [request, setRequest] = useState<PdfRequest>();
  const [history, setHistory] = useState<PdfLocation[]>([]);
  const [moving, setMoving] = useState(false);
  const main = useRef<PageHandle | null>(null);
  const sequence = useRef(0);
  const resolving = useRef(0);
  const pending = useRef<{
    origin: PdfLocation;
    originState: ReadingState;
    back: boolean;
    page: number;
    zoom: number;
  } | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const previewElement = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [previewHeight, setPreviewHeight] = useState(65);
  const drag = useRef<{
    x: number;
    y: number;
  } | null>(null);

  const client = useQueryClient();
  const records = useQuery({
    queryKey: ["annotations", id],
    queryFn: () => api<{ items: Annotation[] }>(`/books/${id}/annotations`),
  });
  const items = records.data?.items ?? [];
  const [selected, setSelected] = useState<TextSelection | null>(null);
  const [selectionPosition, setSelectionPosition] = useState({ x: 12, y: 12 });
  const [color, setColor] = useState<AnnotationColor>("yellow");
  const [annotationDraft, setAnnotationDraft] =
    useState<AnnotationDraft | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const annotationLock = useRef(false);
  const [annotationError, setAnnotationError] = useState("");
  const [annotationNotice, setAnnotationNotice] = useState("");
  const [annotationFocus, setAnnotationFocus] = useState<{
    id: string;
    token: number;
  }>();
  useEffect(() => {
    setSelected(null);
  }, [state.page, state.zoom]);
  useEffect(() => {
    if (!selected) return;
    const clear = () => setSelected(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".annotation-selection-tools"))
        clear();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, [selected]);
  useEffect(() => {
    if (!annotationNotice) return;
    const timer = window.setTimeout(() => setAnnotationNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [annotationNotice]);

  async function saveAnnotation(
    selection: TextSelection,
    color: AnnotationColor,
    note: string,
    existing?: Annotation,
  ) {
    if (annotationLock.current) return false;
    annotationLock.current = true;
    setAnnotationBusy(true);
    setAnnotationError("");
    try {
      const saved = await api<Annotation>(
        `/books/${id}/annotations${existing ? `/${existing.id}` : ""}`,
        {
          method: existing ? "PUT" : "POST",
          body: JSON.stringify(
            existing ? { color, note } : { ...selection, color, note },
          ),
        },
      );
      client.setQueryData<{ items: Annotation[] }>(
        ["annotations", id],
        (previous) => ({
          items: [
            ...(previous?.items ?? []).filter((item) => item.id !== saved.id),
            saved,
          ],
        }),
      );
      setSelected(null);
      window.getSelection()?.removeAllRanges();
      setAnnotationNotice(
        existing ? "기록을 수정했습니다." : "내 기록에 저장했습니다.",
      );
      return true;
    } catch (error) {
      setAnnotationError((error as Error).message);
      return false;
    } finally {
      annotationLock.current = false;
      setAnnotationBusy(false);
    }
  }
  async function deleteAnnotation(annotation: Annotation) {
    if (annotationLock.current) return false;
    annotationLock.current = true;
    setAnnotationBusy(true);
    setAnnotationError("");
    try {
      await api(`/books/${id}/annotations/${annotation.id}`, {
        method: "DELETE",
      });
      client.setQueryData<{ items: Annotation[] }>(
        ["annotations", id],
        (previous) => ({
          items: (previous?.items ?? []).filter(
            (item) => item.id !== annotation.id,
          ),
        }),
      );
      setAnnotationNotice("기록을 삭제했습니다.");
      return true;
    } catch (error) {
      setAnnotationError((error as Error).message);
      return false;
    } finally {
      annotationLock.current = false;
      setAnnotationBusy(false);
    }
  }
  function openAnnotation(annotation: Annotation) {
    setSelected(null);
    setAnnotationError("");
    setAnnotationDraft({
      selection: annotation,
      existing: annotation,
      color: annotation.color,
    });
    onShowAnnotations(true);
  }
  function goToAnnotation(annotation: Annotation) {
    setSelected(null);
    setPreview(null);
    onNavigate({ ...state, page: annotation.page, scroll_offset: 0 });
    setAnnotationFocus({ id: annotation.id, token: Date.now() });
    onShowAnnotations(false);
  }

  useEffect(() => {
    let active = true;
    const loading = getDocument({
      url: `/api/books/${id}/pdf`,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      isEvalSupported: false,
      enableXfa: false,
    });
    loading.promise
      .then((pdf) => {
        if (active) setDocument(pdf);
      })
      .catch(() => {
        if (active)
          setError(
            "PDF를 불러오지 못했습니다. 서버와 원본 파일을 확인해 주세요.",
          );
      });
    return () => {
      active = false;
      resolving.current++;
      void loading.destroy();
    };
  }, [id]);

  function closePreview(restoreFocus = true) {
    resolving.current++;
    if (restoreFocus && preview?.source.isConnected)
      preview.source.focus({ preventScroll: true });
    else if (restoreFocus) main.current?.focus();
    setPreview(null);
  }
  useEffect(() => {
    if (!preview) return;
    closeButton.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [preview?.request.id]);

  useEffect(() => {
    const root = container.current;
    const element = previewElement.current;
    if (!root || !element) return;
    const observer = new ResizeObserver(() => {
      if (window.matchMedia("(max-width: 700px)").matches) return;
      const box = element.getBoundingClientRect(),
        bounds = root.getBoundingClientRect();
      const dx = Math.max(
        bounds.left - box.left,
        Math.min(0, bounds.right - box.right),
      );
      const dy = Math.max(
        bounds.top - box.top,
        Math.min(0, bounds.bottom - box.bottom),
      );
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1)
        setPosition((current) => ({ x: current.x + dx, y: current.y + dy }));
    });
    observer.observe(root);
    observer.observe(element);
    return () => observer.disconnect();
  }, [preview?.request.id]);

  async function openReference(
    destination: unknown,
    source: HTMLElement,
    title: string,
  ) {
    if (!document || pending.current) return;
    const origin = main.current?.capture();
    const token = ++resolving.current;
    setNotice("참조 위치를 확인하는 중…");
    try {
      const target = await resolveReference(document, destination);
      const page = await document.getPage(target.page);
      if (token !== resolving.current) return;
      const viewport = page.getViewport({ scale: 1 });
      const bounds = container.current?.getBoundingClientRect();
      const width = Math.min((bounds?.width ?? window.innerWidth) - 32, 440);
      const height = (bounds?.height ?? window.innerHeight) * 0.58;
      let zoom = (width - 40) / viewport.width;
      if (["Fit", "FitB", "FitV", "FitBV"].includes(target.kind))
        zoom = Math.min(zoom, (height - 90) / viewport.height);
      if (target.kind === "FitR") {
        const r = viewport.convertToViewportRectangle(
          target.coordinates as number[],
        );
        zoom = Math.min(
          (width - 40) / Math.abs(r[2] - r[0]),
          (height - 90) / Math.abs(r[3] - r[1]),
        );
      }
      const sourceRect = source.getBoundingClientRect();
      let initialPosition = { x: 0, y: 0 };
      if (bounds && !window.matchMedia("(max-width: 700px)").matches) {
        const previewHeight = Math.min(
          bounds.height - 32,
          Math.max(180, height),
        );
        const left = bounds.right - 16 - width;
        const top = bounds.bottom - 16 - previewHeight;
        const x = -(bounds.width - width - 32);
        const y = -(bounds.height - previewHeight - 32);
        initialPosition =
          [
            { x: 0, y: 0 },
            { x, y: 0 },
            { x: 0, y },
            { x, y },
          ].find(
            (p) =>
              sourceRect.right + 8 < left + p.x ||
              sourceRect.left - 8 > left + p.x + width ||
              sourceRect.bottom + 8 < top + p.y ||
              sourceRect.top - 8 > top + p.y + previewHeight,
          ) ?? initialPosition;
      }
      setPosition(initialPosition);
      setPreviewHeight(65);
      setPreview({
        target,
        title,
        source,
        request: {
          id: ++sequence.current,
          page: target.page,
          target,
          previous: origin?.page === target.page ? origin.point : undefined,
        },
        state: {
          page: target.page,
          zoom: Math.max(0.2, Math.min(3, zoom)),
          scroll_offset: 0,
        },
      });
      setNotice(
        target.fallback
          ? "이 참조의 좌표 형식을 지원하지 않아 페이지 전체를 표시합니다."
          : "",
      );
    } catch {
      if (token === resolving.current)
        setNotice(
          "참조 위치를 찾지 못했습니다. 링크가 손상되었거나 지원하지 않는 목적지입니다.",
        );
    }
  }

  function move(target: ReferenceTarget | PdfLocation, back: boolean) {
    const origin = main.current?.capture();
    if (pending.current) return;
    if (!origin) {
      setNotice("본문 페이지를 준비하는 중입니다. 잠시 뒤 다시 이동해 주세요.");
      return;
    }
    resolving.current++;
    pending.current = {
      origin,
      originState: state,
      back,
      page: target.page,
      zoom: "zoom" in target ? target.zoom : state.zoom,
    };
    setMoving(true);
    setNotice("");
    setPreview(null);
    setRequest({
      id: ++sequence.current,
      page: target.page,
      previous: origin.page === target.page ? origin.point : undefined,
      ...("kind" in target ? { target } : { point: target.point }),
    });
    onNavigate({
      page: target.page,
      zoom: "zoom" in target ? target.zoom : state.zoom,
      scroll_offset: 0,
    });
  }
  function navigated(page: number, zoom: number) {
    const navigation = pending.current;
    if (!navigation) return;
    pending.current = null;
    setMoving(false);
    // A manual page/zoom change during rendering cancels the reference move.
    if (navigation.page !== page || navigation.zoom !== zoom) {
      setRequest(undefined);
      return;
    }
    setHistory((items) =>
      navigation.back
        ? items.slice(0, -1)
        : [...items.slice(-49), navigation.origin],
    );
    main.current?.focus();
  }
  function failed() {
    const navigation = pending.current;
    if (!navigation) return;
    pending.current = null;
    setMoving(false);
    setNotice("참조 페이지를 표시하지 못해 이전 위치로 돌아갑니다.");
    setRequest({
      id: ++sequence.current,
      page: navigation.origin.page,
      point: navigation.origin.point,
    });
    onNavigate(navigation.originState);
  }

  return (
    <div className="pdf-reference-view" ref={container}>
      {error && (
        <p className="error pdf-notice" role="alert">
          {error}
        </p>
      )}
      {history.length > 0 && (
        <button
          className="reference-back"
          disabled={moving}
          onClick={() => move(history[history.length - 1], true)}
        >
          <ArrowLeft size={14} /> 참조 이동 전으로 돌아가기
        </button>
      )}
      {notice && (
        <div className="reference-notice" role="status">
          {notice}
          <button aria-label="참조 안내 닫기" onClick={() => setNotice("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {document && (
        <PdfPage
          document={document}
          cropMode={cropMode}
          onCrop={onCrop}
          onCropCancel={onCropCancel}
          state={state}
          request={request}
          handle={main}
          onScroll={onScroll}
          onSelection={onSelection}
          annotations={items}
          annotationFocus={annotationFocus}
          onAnnotationClick={openAnnotation}
          onAnnotationSelection={(selection, bounds) => {
            setSelected(selection);
            setAnnotationError("");
            if (bounds && container.current) {
              const box = container.current.getBoundingClientRect();
              setSelectionPosition({
                x: Math.max(
                  8,
                  Math.min(box.width - 284, bounds.left - box.left),
                ),
                y: Math.max(
                  8,
                  Math.min(box.height - 76, bounds.bottom - box.top + 8),
                ),
              });
            }
          }}
          onReady={navigated}
          onError={failed}
          onLink={openReference}
          onUnsupported={() =>
            setNotice("이 파일 링크 또는 PDF 동작은 지원하지 않습니다.")
          }
        />
      )}
      {selected && (
        <div
          className="annotation-selection-tools"
          role="toolbar"
          aria-label="선택한 텍스트 기록"
          style={{ left: selectionPosition.x, top: selectionPosition.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <ColorPicker
            value={color}
            disabled={annotationBusy}
            onChange={(next) => {
              setColor(next);
              void saveAnnotation(selected, next, "");
            }}
          />
          <span className="annotation-tool-divider" />
          <button
            disabled={annotationBusy}
            onClick={() => {
              setAnnotationDraft({ selection: selected, color });
              setSelected(null);
              onShowAnnotations(true);
            }}
          >
            <MessageSquare size={15} /> 주석
          </button>
          <button
            className="icon-button"
            aria-label="선택 도구 닫기"
            disabled={annotationBusy}
            onClick={() => setSelected(null)}
          >
            <X size={14} />
          </button>
          {annotationError && (
            <p className="error" role="alert">
              {annotationError}
            </p>
          )}
        </div>
      )}
      {annotationNotice && (
        <div className="annotation-toast" role="status">
          {annotationNotice}
        </div>
      )}
      <div
        id="reader-annotations"
        className="annotations-drawer"
        hidden={!showAnnotations}
      >
        <AnnotationsPanel
          open={showAnnotations}
          items={items}
          loading={records.isPending}
          loadError={records.error?.message ?? ""}
          retry={() => void records.refetch()}
          draft={annotationDraft}
          setDraft={(next) => {
            setAnnotationDraft(next);
            setAnnotationError("");
          }}
          busy={annotationBusy}
          error={annotationError}
          onSave={saveAnnotation}
          onDelete={deleteAnnotation}
          onNavigate={goToAnnotation}
          onClose={() => {
            onShowAnnotations(false);
          }}
        />
      </div>
      {preview && document && (
        <section
          ref={previewElement}
          className="reference-preview"
          role="dialog"
          aria-modal="false"
          aria-label="참조 미리보기"
          style={
            {
              "--preview-x": `${position.x}px`,
              "--preview-y": `${position.y}px`,
              "--preview-height": `${previewHeight}%`,
            } as CSSProperties
          }
        >
          <div
            className="reference-preview-header"
            onPointerDown={(event) => {
              if (
                (event.target as HTMLElement).closest("button") ||
                window.matchMedia("(max-width: 700px)").matches
              )
                return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = {
                x: event.clientX,
                y: event.clientY,
              };
            }}
            onPointerMove={(event) => {
              if (!drag.current) return;
              const box =
                event.currentTarget.parentElement!.getBoundingClientRect();
              const bounds = event.currentTarget
                .closest(".pdf-stage")!
                .getBoundingClientRect();
              const dx = Math.max(
                bounds.left - box.left,
                Math.min(
                  bounds.right - box.right,
                  event.clientX - drag.current.x,
                ),
              );
              const dy = Math.max(
                bounds.top - box.top,
                Math.min(
                  bounds.bottom - box.bottom,
                  event.clientY - drag.current.y,
                ),
              );
              setPosition({ x: position.x + dx, y: position.y + dy });
              drag.current.x = event.clientX;
              drag.current.y = event.clientY;
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <strong>
              {preview.title || "참조"} · PDF {preview.target.page}쪽
            </strong>
            <button
              ref={closeButton}
              className="icon-button"
              aria-label="참조 미리보기 닫기"
              onClick={() => closePreview()}
            >
              <X size={17} />
            </button>
          </div>
          <div className="reference-preview-tools">
            <input
              className="reference-height"
              type="range"
              aria-label="참조 창 높이"
              min={40}
              max={95}
              value={previewHeight}
              onChange={(event) => setPreviewHeight(Number(event.target.value))}
            />
            <button
              aria-label="참조 축소"
              disabled={preview.state.zoom <= 0.2}
              onClick={() =>
                setPreview({
                  ...preview,
                  state: {
                    ...preview.state,
                    zoom: Math.max(0.2, preview.state.zoom - 0.1),
                  },
                })
              }
            >
              <Minus size={14} />
            </button>
            <span>{Math.round(preview.state.zoom * 100)}%</span>
            <button
              aria-label="참조 확대"
              disabled={preview.state.zoom >= 3}
              onClick={() =>
                setPreview({
                  ...preview,
                  state: {
                    ...preview.state,
                    zoom: Math.min(3, preview.state.zoom + 0.1),
                  },
                })
              }
            >
              <Plus size={14} />
            </button>
            <button
              disabled={moving}
              onClick={() => move(preview.target, false)}
            >
              해당 위치로 이동
            </button>
          </div>
          <PdfPage
            document={document}
            state={preview.state}
            request={preview.request}
            onScroll={(offset) =>
              setPreview((current) =>
                current
                  ? {
                      ...current,
                      state: { ...current.state, scroll_offset: offset },
                    }
                  : null,
              )
            }
          />
        </section>
      )}
    </div>
  );
}
