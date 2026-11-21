import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

const render = (markdown: string) =>
  renderToStaticMarkup(createElement(MarkdownContent, { children: markdown }));

describe("Korean emphasis", () => {
  it("closes bold that ends in quotes before a particle", () => {
    expect(render("러셀은 **“내가 태어난 뒤 시작되었다”**고 한다")).toContain(
      "<strong>“내가 태어난 뒤 시작되었다”</strong>고",
    );
    expect(render('**"자식 없이"**고 생각')).toContain(
      "<strong>&quot;자식 없이&quot;</strong>고",
    );
  });
  it("keeps ordinary emphasis and math intact", () => {
    const html = render("**굵게** 그리고 *기울임*, $x^2$");
    expect(html).toContain("<strong>굵게</strong>");
    expect(html).toContain("<em>기울임</em>");
    expect(html).toContain("katex");
  });
});
