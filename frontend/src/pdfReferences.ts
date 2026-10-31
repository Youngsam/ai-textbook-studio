import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils";

export type PdfPoint = [number, number];
export type ReferenceTarget = {
  page: number;
  kind: string;
  coordinates: (number | null)[];
  fallback: boolean;
};
export type PdfLocation = { page: number; zoom: number; point: PdfPoint };
export type PdfRequest = {
  id: number;
  page: number;
  target?: ReferenceTarget;
  point?: PdfPoint;
  previous?: PdfPoint;
};

const lengths: Record<string, number> = {
  XYZ: 3,
  Fit: 0,
  FitB: 0,
  FitH: 1,
  FitBH: 1,
  FitV: 1,
  FitBV: 1,
  FitR: 4,
};

export async function resolveReference(
  document: Pick<
    PDFDocumentProxy,
    "getDestination" | "getPageIndex" | "numPages"
  >,
  destination: unknown,
): Promise<ReferenceTarget> {
  const dest =
    typeof destination === "string"
      ? await document.getDestination(destination)
      : destination;
  if (!Array.isArray(dest) || dest.length < 2)
    throw new Error("invalid destination");
  const ref = dest[0];
  let page: number;
  if (Number.isInteger(ref)) page = ref + 1;
  else if (ref && Number.isInteger(ref.num) && Number.isInteger(ref.gen))
    page = (await document.getPageIndex(ref)) + 1;
  else throw new Error("invalid page reference");
  if (!Number.isInteger(page) || page < 1 || page > document.numPages)
    throw new Error("destination outside document");
  const kind = dest[1]?.name;
  const count = lengths[kind];
  const coordinates = dest.slice(2);
  const valid =
    count !== undefined &&
    coordinates.length === count &&
    coordinates.every(
      (value: unknown) =>
        value === null || (typeof value === "number" && Number.isFinite(value)),
    ) &&
    (kind !== "FitR" ||
      (coordinates.every((v: unknown) => typeof v === "number") &&
        coordinates[0] < coordinates[2] &&
        coordinates[1] < coordinates[3]));
  return {
    page,
    kind: valid ? kind : "Fit",
    coordinates: valid ? coordinates : [],
    fallback: !valid,
  };
}

// Return a point in viewport coordinates. PDF coordinates must pass through the
// viewport transform, including the page crop and rotation.
export function referencePoint(
  target: ReferenceTarget,
  viewport: PageViewport,
  previous?: PdfPoint,
): PdfPoint {
  const [left, , , top] = viewport.viewBox;
  const c = target.coordinates;
  let point: PdfPoint;
  switch (target.kind) {
    case "XYZ":
      point = [c[0] ?? previous?.[0] ?? left, c[1] ?? previous?.[1] ?? top];
      break;
    case "FitH":
    case "FitBH":
      point = c[0] === null && previous ? previous : [left, c[0] ?? top];
      break;
    case "FitV":
    case "FitBV":
      point = [c[0] ?? previous?.[0] ?? left, top];
      break;
    case "FitR": {
      const rect = viewport.convertToViewportRectangle(c as number[]);
      return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3])];
    }
    default:
      return [0, 0];
  }
  return viewport.convertToViewportPoint(...point) as PdfPoint;
}

export function safeWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
