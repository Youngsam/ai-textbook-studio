import { describe, expect, it, vi } from "vitest";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils";
import { referencePoint, resolveReference, safeWebUrl } from "./pdfReferences";

const document = () => ({
  numPages: 10,
  getDestination: vi.fn(),
  getPageIndex: vi.fn(),
});
describe("PDF destinations", () => {
  it("resolves named destinations and indirect page references without loading all destinations", async () => {
    const pdf = document();
    pdf.getDestination.mockResolvedValue([
      { num: 17, gen: 0 },
      { name: "XYZ" },
      30,
      500,
      null,
    ]);
    pdf.getPageIndex.mockResolvedValue(7);
    expect(await resolveReference(pdf, "figure.2.17b")).toEqual({
      page: 8,
      kind: "XYZ",
      coordinates: [30, 500, null],
      fallback: false,
    });
    expect(pdf.getDestination).toHaveBeenCalledWith("figure.2.17b");
    expect(pdf.getPageIndex).toHaveBeenCalledWith({ num: 17, gen: 0 });
  });
  it("converts zero based integer destinations and rejects missing or invalid pages", async () => {
    const pdf = document();
    expect((await resolveReference(pdf, [0, { name: "Fit" }])).page).toBe(1);
    for (const dest of [
      null,
      [],
      [-1, { name: "Fit" }],
      [10, { name: "Fit" }],
      [{ num: "1", gen: 0 }, { name: "Fit" }],
    ])
      await expect(resolveReference(pdf, dest)).rejects.toThrow();
    pdf.getDestination.mockResolvedValue(null);
    await expect(resolveReference(pdf, "missing")).rejects.toThrow();
  });
  it("falls back to a page view for unsupported or malformed coordinates", async () => {
    const pdf = document();
    for (const tail of [
      [{ name: "Unknown" }],
      [{ name: "XYZ" }, NaN, 0, null],
      [{ name: "FitR" }, 10, 10, 0, 0],
    ])
      expect(await resolveReference(pdf, [1, ...tail])).toMatchObject({
        page: 2,
        kind: "Fit",
        fallback: true,
      });
    for (const kind of [
      "Fit",
      "FitB",
      "FitH",
      "FitBH",
      "FitV",
      "FitBV",
      "FitR",
      "XYZ",
    ]) {
      const coords =
        kind === "XYZ"
          ? [null, null, null]
          : kind === "FitR"
            ? [10, 20, 50, 80]
            : ["Fit", "FitB"].includes(kind)
              ? []
              : [null];
      expect(
        (await resolveReference(pdf, [1, { name: kind }, ...coords])).fallback,
      ).toBe(false);
    }
  });
  it("uses viewport transformations for cropped/rotated destinations and preserves null coordinates", () => {
    const viewport = {
      viewBox: [20, 30, 620, 830],
      convertToViewportPoint: (x: number, y: number) => [
        (830 - y) * 2,
        (x - 20) * 2,
      ],
      convertToViewportRectangle: (r: number[]) => [
        (830 - r[1]) * 2,
        (r[0] - 20) * 2,
        (830 - r[3]) * 2,
        (r[2] - 20) * 2,
      ],
    } as unknown as PageViewport;
    const target = {
      page: 1,
      kind: "XYZ",
      coordinates: [null, null, null],
      fallback: false,
    };
    expect(referencePoint(target, viewport, [80, 600])).toEqual([460, 120]);
    expect(referencePoint(target, viewport)).toEqual([0, 0]);
    expect(
      referencePoint(
        { ...target, kind: "FitR", coordinates: [80, 400, 200, 600] },
        viewport,
      ),
    ).toEqual([460, 120]);
    expect(
      referencePoint(
        { ...target, kind: "FitH", coordinates: [null] },
        viewport,
        [80, 600],
      ),
    ).toEqual([460, 120]);
  });
  it("allows web links but never executable or local file URLs", () => {
    expect(safeWebUrl("https://example.com/a")).toBe("https://example.com/a");
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,test",
      "file:///tmp/test",
      "/local",
      null,
    ])
      expect(safeWebUrl(url)).toBeNull();
  });
});
