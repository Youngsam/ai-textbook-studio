import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { ReadingState } from "./api";

GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfView({
  id,
  state,
  onScroll,
  onSelection,
}: {
  id: string;
  state: ReadingState;
  onScroll: (offset: number) => void;
  onSelection: (value: string) => void;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const callbacks = useRef({ onScroll, onSelection });
  const isReady = useRef(false);
  stateRef.current = state;
  callbacks.current = { onScroll, onSelection };

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
      void loading.destroy();
    };
  }, [id]);

  useEffect(() => {
    if (!document) return;
    let active = true;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    let frame = 0;
    isReady.current = false;
    setRendering(true);
    setError("");
    const run = async () => {
      const page = await document.getPage(state.page);
      if (!active || !canvas.current || !layer.current || !host.current) return;
      const viewport = page.getViewport({ scale: state.zoom });
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
      setRendering(false);
      frame = requestAnimationFrame(() => {
        if (!host.current || !active) return;
        host.current.scrollTop =
          stateRef.current.scroll_offset *
          Math.max(0, host.current.scrollHeight - host.current.clientHeight);
        isReady.current = true;
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
      }
    });
    return () => {
      active = false;
      isReady.current = false;
      cancelAnimationFrame(frame);
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [document, state.page, state.zoom]);

  function captureSelection() {
    const selection = window.getSelection();
    if (
      !selection ||
      !layer.current?.contains(selection.anchorNode) ||
      !layer.current.contains(selection.focusNode)
    )
      return;
    callbacks.current.onSelection(selection.toString().trim());
  }

  return (
    <div
      className="pdf-scroll"
      ref={host}
      onScroll={() => {
        if (host.current && isReady.current)
          callbacks.current.onScroll(
            host.current.scrollTop /
              Math.max(
                1,
                host.current.scrollHeight - host.current.clientHeight,
              ),
          );
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
      <div
        className="pdf-paper"
        style={{ visibility: rendering || error ? "hidden" : "visible" }}
      >
        <canvas ref={canvas} />
        <div ref={layer} className="textLayer" />
      </div>
    </div>
  );
}
