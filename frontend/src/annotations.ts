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

// Page-relative coordinates survive zoom changes without relying on PDF.js DOM nodes.
export function selectionRects(range: Range, paper: DOMRect): AnnotationRect[] {
  const rects: AnnotationRect[] = [];
  if (!paper.width || !paper.height) return rects;
  for (const rect of Array.from(range.getClientRects())) {
    const left = Math.max(paper.left, rect.left),
      top = Math.max(paper.top, rect.top);
    const right = Math.min(paper.right, rect.right),
      bottom = Math.min(paper.bottom, rect.bottom);
    if (right - left < 0.5 || bottom - top < 0.5) continue;
    const item = {
      x: (left - paper.left) / paper.width,
      y: (top - paper.top) / paper.height,
      width: (right - left) / paper.width,
      height: (bottom - top) / paper.height,
    };
    if (
      !rects.some(
        (r) =>
          Math.abs(r.x - item.x) < 0.0001 &&
          Math.abs(r.y - item.y) < 0.0001 &&
          Math.abs(r.width - item.width) < 0.0001 &&
          Math.abs(r.height - item.height) < 0.0001,
      )
    )
      rects.push(item);
  }
  return rects;
}
