import { useEffect, useRef, useState } from "react";

let renderer: Promise<(typeof import("mermaid"))["default"]> | undefined;
function loadRenderer() {
  renderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      maxTextSize: 20000,
      maxEdges: 150,
      htmlLabels: false,
      suppressErrorRendering: true,
    });
    return mermaid;
  });
  return renderer;
}

export default function MermaidDiagram({ source }: { source: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  useEffect(() => {
    let active = true;
    setStatus("loading");
    host.current?.replaceChildren();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (source.length > 20000 || /%%\{|^\s*---/.test(source))
            throw new Error("Unsupported diagram configuration");
          const [mermaid, { default: purify }] = await Promise.all([
            loadRenderer(),
            import("dompurify"),
          ]);
          if (!active) return;
          const { svg } = await mermaid.render(
            `diagram-${crypto.randomUUID()}`,
            source,
          );
          if (!active || !host.current) return;
          host.current.innerHTML = purify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ["foreignObject", "script", "image", "a"],
            FORBID_ATTR: ["href", "xlink:href"],
          });
          setStatus("ready");
        } catch {
          if (active) setStatus("error");
        }
      })();
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [source]);
  return (
    <figure className="diagram">
      <div
        ref={host}
        className="diagram-svg"
        role="img"
        aria-label="설명 다이어그램"
        hidden={status !== "ready"}
      />
      {status === "loading" && (
        <p className="muted diagram-status">다이어그램을 준비하는 중…</p>
      )}
      <details open={status === "error"}>
        <summary>
          {status === "error"
            ? "다이어그램을 표시할 수 없습니다 · 원문 보기"
            : "다이어그램 원문"}
        </summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}
