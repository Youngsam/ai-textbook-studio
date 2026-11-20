import { lazy, memo, Suspense, useMemo } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMath } from "./math";

const MermaidDiagram = lazy(() => import("./MermaidDiagram"));
const remarkPlugins = [remarkMath];

const markdownComponents: Components = {
  code({ className, children, node: _node, ...props }) {
    const source = String(children).replace(/\n$/, "");
    return /(?:^|\s)language-mermaid(?:\s|$)/.test(className ?? "") ? (
      <Suspense fallback={<pre>{source}</pre>}>
        <MermaidDiagram source={source} />
      </Suspense>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <div className="code-block">{children}</div>;
  },
};

export type FigureSource = { src: string; width: number };

// Translations reference cropped page figures as figure:N; nothing else loads as an image.
function figureComponents(
  figure: (index: number) => FigureSource | undefined,
): Components {
  return {
    ...markdownComponents,
    img({ src, alt }) {
      const match = /^figure:(\d+)$/.exec(String(src ?? ""));
      const source = match ? figure(Number(match[1])) : undefined;
      if (!source) return alt ? <span>{alt}</span> : null;
      return (
        <img
          className="translation-figure"
          src={source.src}
          alt={alt ?? ""}
          loading="lazy"
          style={{ width: `${Math.min(100, source.width * 100)}%` }}
        />
      );
    },
  };
}

const keepFigureUrls = (url: string) =>
  /^figure:\d+$/.test(url) ? url : defaultUrlTransform(url);

export const MarkdownContent = memo(function MarkdownContent({
  children,
  figure,
}: {
  children: string;
  /** Resolves figure:N to an image and its width as a fraction of the text column. */
  figure?: (index: number) => FigureSource | undefined;
}) {
  const components = useMemo(
    () => (figure ? figureComponents(figure) : markdownComponents),
    [figure],
  );
  return (
    <ReactMarkdown
      urlTransform={figure ? keepFigureUrls : defaultUrlTransform}
      remarkPlugins={remarkPlugins}
      rehypePlugins={[
        [
          rehypeKatex,
          {
            throwOnError: false,
            strict: "ignore",
            trust: false,
            maxExpand: 1000,
          },
        ],
      ]}
      components={components}
    >
      {normalizeMath(children)}
    </ReactMarkdown>
  );
});
