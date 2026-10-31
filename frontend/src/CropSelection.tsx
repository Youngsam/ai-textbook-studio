import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, X } from "lucide-react";
import type { CropAttachment, CropRect } from "./api";

type Point = { x: number; y: number };
export function CropSelection({
  page,
  canvas,
  onSelect,
  onCancel,
}: {
  page: number;
  canvas: RefObject<HTMLCanvasElement | null>;
  onSelect: (value: CropAttachment) => void;
  onCancel: () => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const start = useRef<Point | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  useEffect(() => {
    overlay.current?.focus({ preventScroll: true });
  }, []);
  function point(event: { clientX: number; clientY: number }): Point {
    const bounds = overlay.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }
  function confirm() {
    const source = canvas.current;
    if (!source || !rect) return;
    const preview = window.document.createElement("canvas");
    const width = rect.width * source.width,
      height = rect.height * source.height;
    const scale = Math.min(1, 480 / Math.max(width, height));
    preview.width = Math.max(1, Math.round(width * scale));
    preview.height = Math.max(1, Math.round(height * scale));
    preview
      .getContext("2d")!
      .drawImage(
        source,
        rect.x * source.width,
        rect.y * source.height,
        width,
        height,
        0,
        0,
        preview.width,
        preview.height,
      );
    onSelect({ page, rect, preview: preview.toDataURL("image/jpeg", 0.9) });
  }
  return (
    <div
      ref={overlay}
      className="crop-overlay"
      tabIndex={0}
      role="group"
      aria-label="PDF 영역 선택: 드래그하거나 방향키로 선택, Shift와 방향키로 크기 조절, Enter로 추가, Escape로 취소"
      onClick={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
        if ((event.target as HTMLElement).closest("button")) return;
        if (event.key === "Enter" && rect) {
          event.preventDefault();
          confirm();
        }
        if (!event.key.startsWith("Arrow")) return;
        event.preventDefault();
        const current = rect ?? { x: 0.2, y: 0.2, width: 0.6, height: 0.3 };
        const dx =
          event.key === "ArrowLeft"
            ? -0.01
            : event.key === "ArrowRight"
              ? 0.01
              : 0;
        const dy =
          event.key === "ArrowUp"
            ? -0.01
            : event.key === "ArrowDown"
              ? 0.01
              : 0;
        setRect(
          event.shiftKey
            ? {
                ...current,
                width: Math.max(
                  0.02,
                  Math.min(1 - current.x, current.width + dx),
                ),
                height: Math.max(
                  0.02,
                  Math.min(1 - current.y, current.height + dy),
                ),
              }
            : {
                ...current,
                x: Math.max(0, Math.min(1 - current.width, current.x + dx)),
                y: Math.max(0, Math.min(1 - current.height, current.y + dy)),
              },
        );
      }}
      onPointerDown={(event) => {
        if (
          (event.target as HTMLElement).closest("button") ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        overlay.current?.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = point(event);
        setRect(null);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const end = point(event),
          origin = start.current;
        setRect({
          x: Math.min(origin.x, end.x),
          y: Math.min(origin.y, end.y),
          width: Math.abs(end.x - origin.x),
          height: Math.abs(end.y - origin.y),
        });
      }}
      onPointerUp={(event) => {
        if (!start.current) return;
        const end = point(event),
          origin = start.current;
        const bounds = event.currentTarget.getBoundingClientRect();
        const width = Math.abs(end.x - origin.x),
          height = Math.abs(end.y - origin.y);
        setRect(
          width * bounds.width >= 8 && height * bounds.height >= 8
            ? {
                x: Math.min(origin.x, end.x),
                y: Math.min(origin.y, end.y),
                width,
                height,
              }
            : null,
        );
        start.current = null;
      }}
      onPointerCancel={() => {
        start.current = null;
        setRect(null);
      }}
    >
      {rect && (
        <div
          className="crop-outline"
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`,
          }}
        />
      )}
      <div className="crop-tools">
        <span>
          {rect ? "선택한 영역을 질문에 첨부" : "수식·도표를 드래그하세요"}
        </span>
        {rect && (
          <button type="button" onClick={confirm}>
            <Check size={14} /> 질문에 추가
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="영역 선택 취소"
          onClick={onCancel}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
