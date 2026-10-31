import { useEffect, useRef, useState, type RefObject } from "react";
import { TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils";
import {
  annotationColors,
  selectionRects,
  type Annotation,
  type TextSelection,
} from "./annotations";
import type { ReadingState } from "./api";
import {
  referencePoint,
  safeWebUrl,
  type PdfLocation,
  type PdfPoint,
  type PdfRequest,
} from "./pdfReferences";

export type PageHandle = {
  capture: () => PdfLocation | null;
  focus: () => void;
};
type Link = {
  rect: number[];
  dest?: unknown;
  url?: string;
  unsupported?: boolean;
};
export function PdfPage({
  document,
  state,
  request,
  handle,
  onScroll,
  onSelection,
  annotations = [],
  onAnnotationSelection,
  onAnnotationClick,
  annotationFocus,
  onLink,
  onUnsupported,
  onReady,
  onError,
}: {
  document: PDFDocumentProxy;
  state: ReadingState;
  request?: PdfRequest;
  handle?: RefObject<PageHandle | null>;
  onScroll?: (offset: number) => void;
  onSelection?: (text: string) => void;
  annotations?: Annotation[];
  onAnnotationSelection?: (
    selection: TextSelection | null,
    bounds?: DOMRect,
  ) => void;
  onAnnotationClick?: (annotation: Annotation) => void;
  annotationFocus?: { id: string; token: number };
  onLink?: (dest: unknown, source: HTMLElement, label: string) => void;
  onUnsupported?: () => void;
  onReady?: (page: number, zoom: number) => void;
  onError?: () => void;
}) {
  const [error, setError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [rendering, setRendering] = useState(true);
  const [renderVersion, setRenderVersion] = useState(0);
  const focusedAnnotation = useRef<number | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PageViewport | null>(null);
  const ready = useRef(false);
  const latest = useRef({ state, onScroll, onSelection, onReady, onError });
  latest.current = { state, onScroll, onSelection, onReady, onError };
  const applied = useRef<number | undefined>(undefined);
  const oldPoint = useRef<PdfLocation | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  function capture(): PdfLocation | null {
    if (
      !ready.current ||
      !host.current ||
      !paper.current ||
      !viewportRef.current
    )
      return null;
    const h = host.current.getBoundingClientRect(),
      p = paper.current.getBoundingClientRect();
    return {
      page: latest.current.state.page,
      zoom: latest.current.state.zoom,
      point: viewportRef.current.convertToPdfPoint(
        h.left - p.left,
        h.top - p.top,
      ) as PdfPoint,
    };
  }
  useEffect(() => {
    if (!handle) return;
    handle.current = {
      capture,
      focus: () => host.current?.focus({ preventScroll: true }),
    };
    return () => {
      handle.current = null;
    };
  }, [handle]);

  useEffect(() => {
    let active = true;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    let frame = 0;
    ready.current = false;
    setRendering(true);
    setError("");
    setLinkError("");
    setLinks([]);
    const run = async () => {
      const page = await document.getPage(state.page);
      if (!active || !canvas.current || !layer.current || !host.current) return;
      const viewport = page.getViewport({ scale: state.zoom });
      viewportRef.current = viewport;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const surface = canvas.current;
      surface.width = Math.floor(viewport.width * ratio);
      surface.height = Math.floor(viewport.height * ratio);
      surface.style.width = `${viewport.width}px`;
      surface.style.height = `${viewport.height}px`;
      layer.current.replaceChildren();
      layer.current.style.width = `${viewport.width}px`;
      layer.current.style.height = `${viewport.height}px`;
      layer.current.style.setProperty("--scale-factor", `${state.zoom}`);
      renderTask = page.render({
        canvasContext: surface.getContext("2d")!,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      await renderTask.promise;
      if (!active) return;
      textLayer = new TextLayer({
        textContentSource: await page.getTextContent(),
        container: layer.current!,
        viewport,
      });
      await textLayer.render();
      if (!active) return;
      if (onLink) {
        // Only link annotations get interactive overlays; PDF actions/scripts and
        // forms are deliberately not handed to a general annotation renderer.
        const annotations = await page
          .getAnnotations({ intent: "display" })
          .catch(() => {
            if (active)
              setLinkError(
                "참조 링크를 읽지 못했습니다. 페이지 본문은 계속 읽을 수 있습니다.",
              );
            return [];
          });
        if (!active) return;
        setLinks(
          annotations
            .filter(
              (a) =>
                a.subtype === "Link" &&
                Array.isArray(a.rect) &&
                a.rect.length === 4 &&
                a.rect.every(Number.isFinite),
            )
            .map((a) => {
              const r = viewport.convertToViewportRectangle(a.rect);
              const rect = [
                Math.min(r[0], r[2]),
                Math.min(r[1], r[3]),
                Math.abs(r[2] - r[0]),
                Math.abs(r[3] - r[1]),
              ];
              const url = safeWebUrl(a.url);
              return {
                rect,
                dest: a.dest,
                url: url ?? undefined,
                unsupported: !a.dest && !url,
              };
            }),
        );
      }
      setRendering(false);
      frame = requestAnimationFrame(() => {
        if (!active || !host.current || !paper.current) return;
        const h = host.current;
        const retained =
          oldPoint.current?.page === state.page &&
          oldPoint.current.zoom !== state.zoom
            ? oldPoint.current
            : null;
        const newRequest =
          request &&
          request.page === state.page &&
          request.id !== applied.current;
        if (newRequest || retained) {
          let point =
            newRequest && request.point
              ? (viewport.convertToViewportPoint(...request.point) as PdfPoint)
              : retained
                ? (viewport.convertToViewportPoint(
                    ...retained.point,
                  ) as PdfPoint)
                : ([0, 0] as PdfPoint);
          if (newRequest && request.target)
            point = referencePoint(
              request.target,
              viewport,
              request.previous ??
                (oldPoint.current?.page === state.page
                  ? oldPoint.current.point
                  : undefined),
            );
          const hostRect = h.getBoundingClientRect(),
            paperRect = paper.current.getBoundingClientRect();
          h.scrollLeft += paperRect.left - hostRect.left + point[0];
          h.scrollTop += paperRect.top - hostRect.top + point[1];
          if (newRequest) applied.current = request.id;
        } else {
          h.scrollTop =
            latest.current.state.scroll_offset *
            Math.max(0, h.scrollHeight - h.clientHeight);
        }
        ready.current = true;
        setRenderVersion((version) => version + 1);
        oldPoint.current = capture();
        if (request && applied.current === request.id)
          latest.current.onScroll?.(
            h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight),
          );
        latest.current.onReady?.(state.page, state.zoom);
      });
    };
    void run().catch((e) => {
      if (
        active &&
        e?.name !== "RenderingCancelledException" &&
        e?.name !== "AbortException"
      ) {
        setError("페이지를 렌더링하지 못했습니다.");
        setRendering(false);
        latest.current.onError?.();
      }
    });
    return () => {
      active = false;
      ready.current = false;
      cancelAnimationFrame(frame);
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [document, state.page, state.zoom, request?.id]);

  useEffect(() => {
    if (
      !annotationFocus ||
      !ready.current ||
      !host.current ||
      focusedAnnotation.current === annotationFocus.token
    )
      return;
    const element = host.current.querySelector<HTMLElement>(
      `[data-annotation-id="${annotationFocus.id}"]`,
    );
    if (element) {
      focusedAnnotation.current = annotationFocus.token;
      element.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
      element.focus({ preventScroll: true });
    }
  }, [annotationFocus, renderVersion]);

  function captureSelection() {
    const selection = window.getSelection();
    if (
      !selection ||
      !layer.current?.contains(selection.anchorNode) ||
      !layer.current.contains(selection.focusNode)
    )
      return;
    const text = selection.toString().trim();
    latest.current.onSelection?.(text);
    if (!text || !selection.rangeCount || !paper.current) {
      onAnnotationSelection?.(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const rects = selectionRects(range, paper.current.getBoundingClientRect());
    if (rects.length)
      onAnnotationSelection?.(
        { page: state.page, selected_text: text, rects },
        range.getBoundingClientRect(),
      );
  }
  function linkLabel(link: HTMLElement) {
    const r = link.getBoundingClientRect();
    return Array.from(layer.current?.querySelectorAll("span") ?? [])
      .filter((span) => {
        const s = span.getBoundingClientRect();
        return (
          s.right > r.left &&
          s.left < r.right &&
          s.bottom > r.top &&
          s.top < r.bottom
        );
      })
      .map((span) => span.textContent)
      .join(" ")
      .trim()
      .slice(0, 100);
  }
  return (
    <div
      className="pdf-scroll"
      ref={host}
      tabIndex={-1}
      aria-label={onLink ? "PDF 본문 페이지" : "참조 페이지"}
      onScroll={() => {
        if (ready.current && host.current) {
          oldPoint.current = capture();
          latest.current.onScroll?.(
            host.current.scrollTop /
              Math.max(
                1,
                host.current.scrollHeight - host.current.clientHeight,
              ),
          );
        }
      }}
      onClick={(event) => {
        if (
          (event.target as HTMLElement).closest("a, button") ||
          !window.getSelection()?.isCollapsed ||
          !paper.current
        )
          return;
        const bounds = paper.current.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width;
        const y = (event.clientY - bounds.top) / bounds.height;
        const match = [...annotations]
          .reverse()
          .find(
            (item) =>
              item.page === state.page &&
              item.rects.some(
                (rect) =>
                  x >= rect.x &&
                  x <= rect.x + rect.width &&
                  y >= rect.y &&
                  y <= rect.y + rect.height,
              ),
          );
        if (match) onAnnotationClick?.(match);
      }}
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
      onTouchEnd={captureSelection}
    >
      {error && (
        <p className="error pdf-notice" role="alert">
          {error}
        </p>
      )}
      {rendering && !error && (
        <div className="pdf-notice" role="status">
          페이지를 준비하는 중…
        </div>
      )}
      {linkError && (
        <p className="pdf-notice" role="status">
          {linkError}
        </p>
      )}
      <div
        ref={paper}
        className="pdf-paper"
        style={{ visibility: rendering || error ? "hidden" : "visible" }}
      >
        <canvas ref={canvas} />
        <div ref={layer} className="textLayer" />
        <div className="pdf-highlight-layer">
          {annotations
            .filter((item) => item.page === state.page)
            .map((item) =>
              item.rects.map((rect, index) => (
                <button
                  key={`${item.id}-${index}`}
                  type="button"
                  className={`pdf-highlight ${annotationFocus?.id === item.id ? "is-active" : ""}`}
                  data-annotation-id={item.id}
                  tabIndex={index === 0 ? 0 : -1}
                  aria-label={`${item.note ? "주석" : "하이라이트"}: ${item.selected_text}`}
                  title={item.note || item.selected_text}
                  style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.width * 100}%`,
                    height: `${rect.height * 100}%`,
                    backgroundColor: annotationColors[item.color].fill,
                  }}
                  onClick={() => onAnnotationClick?.(item)}
                />
              )),
            )}
        </div>
        {onLink && (
          <div className="pdf-link-layer">
            {links.map((link, index) => (
              <a
                key={index}
                ref={(element) => {
                  if (!element || link.url || link.unsupported) return;
                  const text = linkLabel(element);
                  if (text) {
                    element.setAttribute(
                      "aria-label",
                      `참조 미리보기: ${text}`,
                    );
                    element.title = `참조 미리보기: ${text}`;
                  }
                }}
                className="pdf-reference-link"
                draggable={false}
                style={{
                  left: link.rect[0],
                  top: link.rect[1],
                  width: link.rect[2],
                  height: link.rect[3],
                }}
                href={link.url ?? "#pdf-reference"}
                target={link.url ? "_blank" : undefined}
                rel={link.url ? "noopener noreferrer" : undefined}
                aria-label={
                  link.url
                    ? "외부 링크 새 탭에서 열기"
                    : link.unsupported
                      ? "지원하지 않는 PDF 링크"
                      : `참조 미리보기 ${index + 1}`
                }
                title={link.url ? "외부 링크 새 탭에서 열기" : "참조 미리보기"}
                onPointerDown={(event) => {
                  pointerStart.current = { x: event.clientX, y: event.clientY };
                }}
                onClick={(event) => {
                  if (
                    event.detail &&
                    pointerStart.current &&
                    Math.hypot(
                      event.clientX - pointerStart.current.x,
                      event.clientY - pointerStart.current.y,
                    ) > 5
                  ) {
                    event.preventDefault();
                    return;
                  }
                  if (link.url) return;
                  event.preventDefault();
                  if (link.unsupported) onUnsupported?.();
                  else
                    onLink(
                      link.dest,
                      event.currentTarget,
                      linkLabel(event.currentTarget),
                    );
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
