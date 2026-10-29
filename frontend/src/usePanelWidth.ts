import { useEffect, useRef, useState, type PointerEvent } from "react";

const KEY = "textbook-studio.chat-width";

export function usePanelWidth() {
  const container = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; start: number; width: number } | null>(
    null,
  );
  const [desired, setDesired] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(KEY));
      return Number.isFinite(saved) && saved >= 300
        ? Math.min(820, saved)
        : 390;
    } catch {
      return 390;
    }
  });
  const [maximum, setMaximum] = useState(820);
  const width = Math.min(maximum, Math.max(300, desired));

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setMaximum(Math.max(300, Math.min(820, entry.contentRect.width - 360))),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  function resize(next: number) {
    const value = Math.round(Math.min(maximum, Math.max(300, next)));
    setDesired(value);
    try {
      localStorage.setItem(KEY, String(value));
    } catch {
      /* Storage can be disabled. */
    }
  }

  function stop(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return {
    container,
    width,
    separator: {
      role: "separator" as const,
      tabIndex: 0,
      "aria-label": "학습 도우미 너비 조절",
      "aria-controls": "learning-assistant",
      "aria-orientation": "vertical" as const,
      "aria-valuemin": 300,
      "aria-valuemax": maximum,
      "aria-valuenow": width,
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = {
          pointer: event.pointerId,
          start: event.clientX,
          width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (drag.current?.pointer === event.pointerId)
          resize(drag.current.width + drag.current.start - event.clientX);
      },
      onPointerUp: stop,
      onPointerCancel: stop,
      onLostPointerCapture() {
        drag.current = null;
      },
      onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        resize(
          event.key === "Home"
            ? 300
            : event.key === "End"
              ? maximum
              : width + (event.key === "ArrowLeft" ? 20 : -20),
        );
      },
      onDoubleClick() {
        resize(390);
      },
    },
  };
}
