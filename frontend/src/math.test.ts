import { describe, expect, it } from "vitest";
import { normalizeMath } from "./math";

describe("LaTeX compatibility", () => {
  it("normalizes inline and display LaTeX delimiters", () => {
    expect(
      normalizeMath(String.raw`확률 \(p(y_2 \mid y_1)\)와 \[\frac{a}{b}\]`),
    ).toBe("확률 $p(y_2 \\mid y_1)$와 \n\n$$\n\\frac{a}{b}\n$$\n\n");
  });
  it("treats a line holding only $$...$$ as display math", () => {
    expect(
      normalizeMath(String.raw`따라서
$$\frac{a}{b} \tag{15.1}$$
그리고 $$x$$는 인라인`),
    ).toBe(
      "따라서\n\n$$\n\\frac{a}{b} \\tag{15.1}\n$$\n\n그리고 $$x$$는 인라인",
    );
  });
  it("preserves existing math and literal code examples", () => {
    const content =
      '`\\(literal\\)` and $x_2$\n```mermaid\ngraph LR\n A["\\(not math\\)"] --> B\n```';
    expect(normalizeMath(content)).toBe(content);
  });
});
