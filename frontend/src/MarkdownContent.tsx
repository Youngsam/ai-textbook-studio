import { lazy, memo, Suspense } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
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

export const MarkdownContent = memo(function MarkdownContent({
  children,
}: {
  children: string;
}) {
  return (
    <ReactMarkdown
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
      components={markdownComponents}
    >
      {normalizeMath(children)}
    </ReactMarkdown>
  );
});
