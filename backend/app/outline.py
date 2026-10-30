"""Conservative, local contents-page recognition. Never modifies the source PDF."""

import re
from collections import Counter
from dataclasses import dataclass

import pymupdf

HEADING = re.compile(
    r"^(?:[\divxlc()|]+\s+)?(?:table\s+of\s+contents|contents|목\s*차|차\s*례)"
    r"(?:\s*\(?continued\)?|\s+[\divxlc()|]+)?$",
    re.I,
)
EXCLUDED = re.compile(
    r"^(?:list\s+of\s+(?:figures|tables|illustrations)|그림\s*목차|표\s*목차|"
    r"그림\s*차례|표\s*차례|도표\s*목차)",
    re.I,
)
CAPTION = re.compile(r"^(?:fig(?:ure)?\.?|table|그림|표|도표)\s*\d", re.I)
LEADERS = re.compile(r"[.·…_\-\s]+$")


@dataclass
class Row:
    x: float
    y: float
    right: float
    text: str
    words: list


def read_rows(page, language, tessdata, *, force_ocr=False):
    words = page.get_text("words")
    # Image scans and broken text layers need OCR. Existing legible text stays local too.
    text = " ".join(w[4] for w in words)
    used_ocr = (
        force_ocr
        or not words
        or (len(re.sub(r"\W", "", text)) < 40 and bool(page.get_images()))
        or text.count("�") > len(text) * 0.1
    )
    if used_ocr:
        tp = page.get_textpage_ocr(language=language, dpi=180, full=True, tessdata=tessdata)
        words = page.get_text("words", textpage=tp)
    return rows_from_words(words), used_ocr


def rows_from_words(words):
    expanded = []
    for word in words:
        joined = re.fullmatch(r"(.+?[.·…_]{2,})(\d{1,5})", word[4])
        if joined:
            boundary = word[2] - (word[3] - word[1]) * 0.55 * len(joined[2])
            expanded.extend(
                [
                    (*word[:2], boundary, word[3], joined[1], *word[5:]),
                    (boundary, word[1], word[2], word[3], joined[2], *word[5:]),
                ]
            )
        else:
            expanded.append(word)
    groups = []
    for word in sorted(expanded, key=lambda w: (w[1], w[0])):
        center = (word[1] + word[3]) / 2
        if groups and abs(center - groups[-1][0]) < max(3, (word[3] - word[1]) * 0.45):
            groups[-1][1].append(word)
        else:
            groups.append((center, [word]))
    rows = []
    for _, group in groups:
        group.sort(key=lambda w: w[0])
        rows.append(
            Row(
                group[0][0],
                min(w[1] for w in group),
                group[-1][2],
                " ".join(w[4] for w in group),
                group,
            )
        )
    return rows


def repair_page_numbers(page, rows, language, tessdata):
    """Re-read only the number column of scanned contents with a damaged text layer.

    Dot leaders confuse Tesseract's layout analysis. Remove tiny connected components
    from this narrow crop, preserving the original grayscale shapes of the digits.
    Titles keep their existing text and coordinates.
    """
    headings = [
        r for r in rows if r.y < page.rect.height * 0.35 and HEADING.fullmatch(r.text.strip())
    ]
    if not headings or not page.get_images():
        return rows, False
    heading = headings[0]
    top = max(w[3] for w in heading.words) + 3
    body = [r for r in rows if r.y > top]
    # Leave multi-column contents to the normal layout parser.
    if (
        sum(r.x > page.rect.width * 0.5 and bool(re.search(r"[^\W\d_]", r.text)) for r in body)
        > len(body) * 0.25
    ):
        return rows, False
    scale = 4
    clip = pymupdf.Rect(
        page.rect.width * 0.80, top, page.rect.width * 0.94, page.rect.height * 0.94
    )
    pixmap = page.get_pixmap(
        matrix=pymupdf.Matrix(scale, scale), clip=clip, colorspace=pymupdf.csGRAY, alpha=False
    )
    cleaned = clean_leaders(pixmap)
    ocr_language = "eng" if "eng" in language.split("+") else language
    with pymupdf.open(
        "pdf", cleaned.pdfocr_tobytes(language=ocr_language, tessdata=tessdata)
    ) as recognized:
        numbers = [w for w in recognized[0].get_text("words") if re.fullmatch(r"\d{1,5}", w[4])]
    if len(numbers) < 3:
        return rows, False
    origin_x, origin_y = pixmap.x / scale, pixmap.y / scale
    left = origin_x + min(w[0] for w in numbers) - 2
    words = [w for r in rows for w in r.words if w[1] < top or w[0] < left]
    words.extend(
        (w[0] + origin_x, w[1] + origin_y, w[2] + origin_x, w[3] + origin_y, w[4], 0, 0, 0)
        for w in numbers
    )
    repaired = rows_from_words(words)
    missing_titles = any(r.y > top and all(w[0] >= left for w in r.words) for r in repaired)
    broken_chapters = any(
        re.match(r"^Chapter\s", r.text, re.I) and not re.match(r"^Chapter\s+\d+[.\s]", r.text, re.I)
        for r in repaired
    )
    if missing_titles or broken_chapters:
        repaired = recover_titles(page, repaired, left, top, ocr_language, tessdata)
    return repaired, True


def recover_titles(page, rows, number_left, top, language, tessdata):
    """Recover missing headings without trusting the newly OCRed page numbers."""
    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(4, 4), colorspace=pymupdf.csGRAY, alpha=False)
    # Keep chapter/section punctuation at the left edge of the page.
    cleaned = clean_leaders(pixmap, min_x=int(pixmap.width * 0.3))
    with pymupdf.open(
        "pdf", cleaned.pdfocr_tobytes(language=language, tessdata=tessdata)
    ) as document:
        recognized = rows_from_words(document[0].get_text("words"))
    output = []
    for row in rows:
        words = row.words
        center = sum((w[1] + w[3]) / 2 for w in words) / len(words)
        matches = [
            r
            for r in recognized
            if abs(sum((w[1] + w[3]) / 2 for w in r.words) / len(r.words) - center) < 4
        ]
        match = min(matches, key=lambda r: abs(r.y - row.y)) if matches else None
        title = [w for w in words if w[0] < number_left]
        if match and row.y > top:
            missing = not re.search(r"[^\W\d_]", " ".join(w[4] for w in title))
            chapter = re.match(r"^Chapter\s+\d+[.\s]", match.text, re.I)
            if missing or chapter:
                title = [w for w in match.words if w[0] < number_left]
                words = [*title, *(w for w in words if w[0] >= number_left)]
        output.extend(words)
    return rows_from_words(output)


def clean_leaders(pixmap, min_x=0):
    width, height = pixmap.width, pixmap.height
    samples = bytearray(pixmap.samples)
    visited = bytearray(width * height)
    for position in range(len(samples)):
        if samples[position] >= 180 or visited[position]:
            continue
        stack, component = [position], []
        visited[position] = 1
        low = high = position // width
        while stack:
            current = stack.pop()
            component.append(current)
            y, x = divmod(current, width)
            low, high = min(low, y), max(high, y)
            neighbors = (
                current - 1 if x else -1,
                current + 1 if x < width - 1 else -1,
                current - width,
                current + width,
            )
            for neighbor in neighbors:
                if (
                    0 <= neighbor < len(samples)
                    and samples[neighbor] < 180
                    and not visited[neighbor]
                ):
                    visited[neighbor] = 1
                    stack.append(neighbor)
        if high - low < 9 and min(k % width for k in component) >= min_x:
            for current in component:
                samples[current] = 255
    cleaned = pymupdf.Pixmap(pymupdf.csGRAY, width, height, bytes(samples), False)
    # MuPDF's OCR path requires RGB for reliable recognition of this cleaned crop.
    cleaned = pymupdf.Pixmap(pymupdf.csRGB, cleaned)
    cleaned.set_dpi(288, 288)
    return cleaned


def entries_on_page(rows, width, height, continuation=False):
    headings = [r for r in rows if r.y < height * 0.35 and HEADING.fullmatch(r.text.strip())]
    if not headings and not continuation:
        return []
    start = headings[0].y if headings else -1
    stop = min((r.y for r in rows if r.y > start and EXCLUDED.match(r.text)), default=height)
    candidates, body_rows = [], 0
    for row in rows:
        if not start < row.y < min(stop, height * 0.94):
            continue
        if HEADING.fullmatch(row.text.strip()):
            continue
        body_rows += 1
        words = row.words
        # Reject numeric tables, even if their caption happens to mention contents.
        two_columns = any(
            re.fullmatch(r"\d+", a[4])
            and re.search(r"[^\W\d_]", b[4])
            and b[0] - a[2] > width * 0.07
            for a, b in zip(words, words[1:])
        )
        if not two_columns and sum(bool(re.fullmatch(r"\d+(?:[.,]\d+)?", w[4])) for w in words) > 3:
            continue
        chunk = []
        row_candidates = []
        for index, word in enumerate(words):
            match = re.fullmatch(r"[.·…_]*(\d{1,5})", word[4])
            if match and chunk:
                title = LEADERS.sub("", " ".join(w[4] for w in chunk)).strip()
                gap = word[0] - chunk[-1][2]
                leader = bool(re.search(r"[.·…_]{2,}$", " ".join(w[4] for w in chunk)))
                # A page number must terminate a row/column and be visually separated.
                end = index == len(words) - 1 or words[index + 1][0] - word[2] > width * 0.07
                if end and (gap >= 10 or leader) and len(re.findall(r"[^\W\d_]", title)) >= 2:
                    numeric_cells = any(
                        re.fullmatch(r"\d+(?:[.,]\d+)?", b[4])
                        and b[0] - a[2] >= width * 0.035
                        and re.search(r"[^\W\d_]", " ".join(w[4] for w in chunk[: position + 1]))
                        for position, (a, b) in enumerate(zip(chunk, chunk[1:]))
                    )
                    if not numeric_cells and not CAPTION.match(title) and not EXCLUDED.match(title):
                        row_candidates.append(
                            {
                                "title": title[:300],
                                "printed_page": int(match[1]),
                                "x": chunk[0][0],
                                "right": word[2],
                                "y": row.y,
                            }
                        )
                    chunk = []
                    continue
            chunk.append(word)
        if not chunk:
            candidates.extend(row_candidates)
    if len(candidates) < 3 or len(candidates) / max(1, body_rows) < 0.55:
        return []
    # Two columns are read top-to-bottom within each column.
    lefts = sorted(c["x"] for c in candidates)
    split = next((b for a, b in zip(lefts, lefts[1:]) if b - a > width * 0.22), None)
    candidates.sort(key=lambda c: (int(split is not None and c["x"] >= split), c["y"]))
    numbers = [c["printed_page"] for c in candidates]
    if any(n < 1 for n in numbers):
        return []
    if sum(a <= b for a, b in zip(numbers, numbers[1:])) / (len(numbers) - 1) < 0.9:
        return []
    # Page-number right edges must align (one cluster per column).
    clusters = []
    for edge in sorted(c["right"] for c in candidates):
        if not clusters or edge - clusters[-1][0] > 12:
            clusters.append([edge])
        else:
            clusters[-1].append(edge)
    aligned = sorted((len(cluster) for cluster in clusters), reverse=True)
    if sum(aligned[: 2 if split else 1]) < len(candidates) * 0.75:
        return []
    base = min(c["x"] for c in candidates)
    for candidate in candidates:
        candidate["title"] = re.sub(
            r"^\d+(?:\.\s*\d+)+",
            lambda match: re.sub(r"\s+", "", match[0]),
            candidate["title"],
        )
        prefix = re.match(r"^(\d+(?:\.\d+)*)(?:\.?\s)", candidate["title"])
        candidate["level"] = (
            min(6, 1 + prefix[1].count("."))
            if prefix
            else (
                2 if candidate["x"] - base > 14 and (split is None or candidate["x"] < split) else 1
            )
        )
    return candidates


def detect_outline(document, *, language="kor+eng", tessdata=None, max_pages=24):
    embedded = [
        {"level": level, "title": title, "page": target}
        for level, title, target in document.get_toc()
        if 1 <= target <= document.page_count
    ]
    if embedded:
        return {"items": embedded}
    candidates, offsets, used_ocr = [], [], False
    previous = False
    ocr_unavailable = False
    for index in range(min(document.page_count, max_pages)):
        page = document[index]
        try:
            rows, ocr = read_rows(page, language, tessdata)
        except (RuntimeError, ValueError, pymupdf.mupdf.FzErrorBase):
            # Missing language data must not turn an ordinary PDF into an API error.
            ocr_unavailable = True
            previous = False
            continue
        current = entries_on_page(rows, page.rect.width, page.rect.height, previous)
        has_heading = any(
            r.y < page.rect.height * 0.35 and HEADING.fullmatch(r.text.strip()) for r in rows
        )
        if not ocr and has_heading and page.get_images():
            try:
                repaired, changed = repair_page_numbers(page, rows, language, tessdata)
                recovered = entries_on_page(repaired, page.rect.width, page.rect.height, previous)
                if changed and recovered and len(recovered) >= len(current) * 0.85:
                    current, ocr = recovered, True
            except (RuntimeError, ValueError, pymupdf.mupdf.FzErrorBase):
                ocr_unavailable = True
        if current:
            used_ocr |= ocr
        if (
            current
            and candidates
            and not has_heading
            and current[-1]["printed_page"] < candidates[-1]["printed_page"]
        ):
            current = []
        candidates.extend(current)
        previous = bool(current)
        footers = [
            int(r.text.strip())
            for r in rows
            if r.y > page.rect.height * 0.9 and re.fullmatch(r"\d{1,5}", r.text.strip())
        ]
        if len(footers) == 1:
            offsets.append(index + 1 - footers[0])
    if not candidates:
        return {"items": [], **({"status": "ocr_unavailable"} if ocr_unavailable else {})}
    votes = Counter(offsets)
    offset, count = votes.most_common(1)[0] if votes else (0, 0)
    verified = count >= 2 and count > len(offsets) / 2
    items, seen = [], set()
    for entry in candidates:
        printed = entry["printed_page"]
        key = entry["title"], printed
        if key in seen:
            continue
        seen.add(key)
        target = printed + offset
        items.append(
            {
                "level": entry["level"],
                "title": entry["title"],
                "printed_page": printed,
                "page": target if verified and 1 <= target <= document.page_count else None,
            }
        )
    return {
        "items": items,
        "source": "ocr" if used_ocr else "text",
        "mapping_verified": verified,
        "page_offset": offset if verified else None,
        "scanned_pages": min(document.page_count, max_pages),
        **({"status": "ocr_unavailable"} if ocr_unavailable else {}),
    }
