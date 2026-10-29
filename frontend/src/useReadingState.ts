import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ReadingState } from "./api";

export function useReadingState(id: string, initial: ReadingState) {
  const [state, setState] = useState(initial);
  const [status, setStatus] = useState("저장됨");
  const pending = useRef<ReadingState | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current);
    if (running.current) return running.current;
    const work = async () => {
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        setStatus("저장 중…");
        try {
          await api(`/books/${id}/state`, {
            method: "PUT",
            body: JSON.stringify(next),
            keepalive: true,
          });
        } catch {
          pending.current ??= next;
          setStatus("저장 실패");
          return false;
        }
      }
      setStatus("저장됨");
      return true;
    };
    running.current = work().finally(() => {
      running.current = null;
    });
    return running.current;
  }, [id]);

  const change = useCallback(
    (next: ReadingState) => {
      setState(next);
      pending.current = next;
      setStatus("저장 대기");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush();
      }, 500);
    },
    [flush],
  );

  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const online = () => {
      void flush();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("online", online);
      clearTimeout(timer.current);
      if (pending.current) void flush();
    };
  }, [flush]);
  return { state, change, flush, status };
}
