// Display helpers for pages the tutor looked up beyond the current page.

export function pageRanges(pages: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const page of [...new Set(pages)].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && page === last[1] + 1) last[1] = page;
    else ranges.push([page, page]);
  }
  return ranges;
}

export function rangeLabel([start, end]: [number, number]) {
  return start === end ? `p.${start}` : `p.${start}–${end}`;
}

export function lookupLabel(name: string, args: Record<string, unknown>) {
  if (name === "search_book")
    return `책에서 "${String(args.query ?? "")}" 찾는 중…`;
  if (name === "read_pages") {
    const start = Number(args.start);
    const end = Number(args.end ?? start);
    return `${rangeLabel([start, Math.max(start, end)])} 읽는 중…`;
  }
  return "책을 살펴보는 중…";
}
