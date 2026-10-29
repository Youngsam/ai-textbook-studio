import { describe, expect, it } from "vitest";
import { normalizeMath } from "./math";

describe("LaTeX compatibility", () => {
  it("normalizes inline and display LaTeX delimiters", () => {
    expect(
      normalizeMath(String.raw`확률 \(p(y_2 \mid y_1)\)와 \[\frac{a}{b}\]`),
    ).toBe("확률 $p(y_2 \\mid y_1)$와 \n\n$$\n\\frac{a}{b}\n$$\n\n");
  });
  it("preserves existing math and literal code examples", () => {
    const content =
      '`\\(literal\\)` and $x_2$\n```mermaid\ngraph LR\n A["\\(not math\\)"] --> B\n```';
    expect(normalizeMath(content)).toBe(content);
  });
});
