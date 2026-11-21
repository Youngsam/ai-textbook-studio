import { describe, expect, it } from "vitest";
import { mergeLineBoxes } from "./annotations";

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe("mergeLineBoxes", () => {
  it("bridges word gaps and evens out heights within a line", () => {
    expect(
      mergeLineBoxes([
        box(10, 100, 50, 118),
        box(56, 101, 90, 119),
        box(95, 99, 130, 118),
      ]),
    ).toEqual([box(10, 100, 130, 118)]);
  });

  it("collapses duplicate and overlapping boxes into one bar", () => {
    expect(
      mergeLineBoxes([
        box(10, 100, 60, 118),
        box(10, 100, 60, 118),
        box(55, 100, 80, 118),
      ]),
    ).toEqual([box(10, 100, 80, 118)]);
  });

  it("keeps separate lines and splits their vertical overlap", () => {
    expect(
      mergeLineBoxes([box(10, 100, 200, 120), box(10, 116, 120, 136)]),
    ).toEqual([box(10, 100, 200, 118), box(10, 118, 120, 136)]);
  });

  it("does not bridge a column gutter", () => {
    expect(
      mergeLineBoxes([box(10, 100, 100, 118), box(160, 100, 250, 118)]),
    ).toHaveLength(2);
  });

  it("keeps superscripts on their line and drops container-sized boxes", () => {
    expect(
      mergeLineBoxes([
        box(10, 100, 80, 118),
        box(80, 98, 85, 106),
        box(88, 100, 140, 118),
        box(0, 0, 300, 400),
      ]),
    ).toEqual([box(10, 100, 140, 118)]);
  });

  it("ignores empty boxes", () => {
    expect(mergeLineBoxes([box(10, 10, 10, 20)])).toEqual([]);
  });
});
