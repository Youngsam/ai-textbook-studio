import { describe, expect, it } from "vitest";
import { lookupLabel, pageRanges, rangeLabel } from "./bookLookup";

describe("book lookup labels", () => {
  it("groups consecutive pages into ranges", () => {
    expect(pageRanges([7, 3, 4, 5, 9, 4])).toEqual([
      [3, 5],
      [7, 7],
      [9, 9],
    ]);
    expect(pageRanges([7, 3, 4, 5, 9]).map(rangeLabel)).toEqual([
      "p.3–5",
      "p.7",
      "p.9",
    ]);
  });

  it("describes tool activity", () => {
    expect(lookupLabel("read_pages", { start: 12, end: 14 })).toBe(
      "p.12–14 읽는 중…",
    );
    expect(lookupLabel("read_pages", { start: 12 })).toBe("p.12 읽는 중…");
    expect(lookupLabel("search_book", { query: "고유값" })).toBe(
      '책에서 "고유값" 찾는 중…',
    );
  });
});
