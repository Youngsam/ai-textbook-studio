export const annotationColors = {
  yellow: { label: "노랑", fill: "#efd574" },
  green: { label: "초록", fill: "#9dc8a3" },
  blue: { label: "파랑", fill: "#9abfe5" },
  pink: { label: "분홍", fill: "#e4a9ba" },
} as const;
export type AnnotationColor = keyof typeof annotationColors;
export type AnnotationRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type TextSelection = {
  page: number;
  selected_text: string;
  rects: AnnotationRect[];
};
export type Annotation = TextSelection & {
  id: string;
  book_id: string;
  color: AnnotationColor;
  note: string;
  created_at: string;
  updated_at: string;
};

export type Box = { left: number; top: number; right: number; bottom: number };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// PDF.js emits one span per text run (per word in OCR scans), so raw client rects
// leave gaps between words and overlap at their edges. Collapse them into one bar
// per line segment with a uniform height so the fill looks continuous.
export function mergeLineBoxes(boxes: Box[]): Box[] {
  const items = boxes.filter(
    (b) => b.right - b.left >= 0.5 && b.bottom - b.top >= 0.5,
  );
  if (!items.length) return [];
  // Drop container-sized boxes (e.g. a fully selected wrapper element).
  const limit = median(items.map((b) => b.bottom - b.top)) * 2.5;
  const lines: Box[][] = [];
  // Tallest boxes seed the lines so superscripts join the line they sit on.
  for (const box of items
    .filter((b) => b.bottom - b.top <= limit)
    .sort((a, b) => b.bottom - b.top - (a.bottom - a.top))) {
    const center = (box.top + box.bottom) / 2;
    const line = lines.find(
      (members) => center >= members[0].top && center <= members[0].bottom,
    );
    if (line) line.push(box);
    else lines.push([box]);
  }
  const bands = lines
    .map((members) => ({
      members,
      top: median(members.map((b) => b.top)),
      bottom: median(members.map((b) => b.bottom)),
    }))
    .sort((a, b) => a.top - b.top);
  // Neighbouring OCR lines often overlap; split the difference so bars never stack.
  for (let i = 1; i < bands.length; i++) {
    const above = bands[i - 1],
      below = bands[i];
    if (above.bottom > below.top) {
      const middle = (above.bottom + below.top) / 2;
      above.bottom = middle;
      below.top = middle;
    }
  }
  const merged: Box[] = [];
  for (const { members, top, bottom } of bands) {
    // Bridge word gaps but not column gutters.
    const maxGap = (bottom - top) * 1.5;
    let segment: Box | null = null;
    for (const box of [...members].sort((a, b) => a.left - b.left)) {
      if (segment && box.left - segment.right <= maxGap)
        segment.right = Math.max(segment.right, box.right);
      else {
        segment = { left: box.left, top, right: box.right, bottom };
        merged.push(segment);
      }
    }
  }
  return merged;
}

// Page-relative coordinates survive zoom changes without relying on PDF.js DOM nodes.
export function selectionRects(range: Range, paper: DOMRect): AnnotationRect[] {
  if (!paper.width || !paper.height) return [];
  const boxes = Array.from(range.getClientRects()).map((rect) => ({
    left: Math.max(paper.left, rect.left),
    top: Math.max(paper.top, rect.top),
    right: Math.min(paper.right, rect.right),
    bottom: Math.min(paper.bottom, rect.bottom),
  }));
  return mergeLineBoxes(boxes).map((box) => ({
    x: (box.left - paper.left) / paper.width,
    y: (box.top - paper.top) / paper.height,
    width: (box.right - box.left) / paper.width,
    height: (box.bottom - box.top) / paper.height,
  }));
}
