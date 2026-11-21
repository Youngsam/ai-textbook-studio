"""PDF work runs in a bounded child process; documents never cross process boundaries."""

import asyncio
import json
import multiprocessing
import time
from pathlib import Path

import pymupdf

from app.outline import detect_outline

OUTLINE_CACHE_VERSION = 2
PAGE_TEXT_CACHE = "pages-v1.json"


def cached_outline(path):
    """Outline items already detected for the reader, without starting OCR."""
    try:
        stored = json.loads(Path(path).with_name("outline-v1.json").read_text())
        if stored.get("version") != OUTLINE_CACHE_VERSION:
            return []
        return stored["result"].get("items", [])
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return []


def detect_figures(page, limit=8, gap=24):
    """Find embedded images and vector drawings large enough to be figures.

    Returns normalized rects in displayed (rotation-applied) page coordinates,
    the same space used by user crops.
    """
    area = page.rect
    candidates = [pymupdf.Rect(info["bbox"]) for info in page.get_image_info()]
    try:
        candidates += page.cluster_drawings()
    except Exception:
        pass
    # Pad by half the gap so separated marks (bars, points, labels' boxes) merge first.
    pad = gap / 2
    rects = []
    for rect in candidates:
        rect = (rect * page.rotation_matrix) & area
        if not rect.is_empty:
            rects.append(rect + (-pad, -pad, pad, pad))
    merged = True
    while merged:
        merged = False
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                if rects[i].intersects(rects[j]):
                    rects[i] |= rects.pop(j)
                    merged = True
                    break
            if merged:
                break
    figures = []
    for rect in rects:
        rect = (rect + (pad - 4, pad - 4, 4 - pad, 4 - pad)) & area
        # Skip rules, small glyph art, and full-page scans or backgrounds.
        if rect.width < area.width * 0.15 or rect.height < area.height * 0.06:
            continue
        if rect.width * rect.height > area.width * area.height * 0.85:
            continue
        figures.append(rect)
    figures.sort(key=lambda rect: (rect.y0, rect.x0))
    return [
        {
            "x": round(rect.x0 / area.width, 4),
            "y": round(rect.y0 / area.height, 4),
            "width": round(rect.width / area.width, 4),
            "height": round(rect.height / area.height, 4),
        }
        for rect in figures[:limit]
    ]


def _worker(pipe, operation, path, page, image_path, outline_options, crop=None):
    try:
        with pymupdf.open(path) as document:
            if document.needs_pass or not document.is_pdf or document.page_count < 1:
                raise ValueError("invalid_pdf")
            if operation == "inspect":
                result = {"page_count": document.page_count}
            elif operation == "outline":
                cache = Path(path).with_name("outline-v1.json")
                try:
                    stored = json.loads(cache.read_text())
                    result = (
                        stored["result"]
                        if (
                            stored.get("version") == OUTLINE_CACHE_VERSION
                            and stored["options"] == outline_options
                        )
                        else None
                    )
                except (OSError, ValueError, KeyError, TypeError):
                    result = None
                if result is None:
                    result = detect_outline(document, **outline_options)
                    if result.get("status") != "ocr_unavailable":
                        temporary = cache.with_suffix(".tmp")
                        temporary.write_text(
                            json.dumps(
                                {
                                    "version": OUTLINE_CACHE_VERSION,
                                    "options": outline_options,
                                    "result": result,
                                },
                                ensure_ascii=False,
                            )
                        )
                        temporary.replace(cache)
            elif operation == "texts":
                cache = Path(path).with_name(PAGE_TEXT_CACHE)
                if not cache.exists():
                    temporary = cache.with_suffix(".tmp")
                    temporary.write_text(
                        json.dumps(
                            [current.get_text(sort=True) for current in document],
                            ensure_ascii=False,
                        )
                    )
                    temporary.replace(cache)
                result = {"path": str(cache)}
            elif operation == "figures":
                result = {"figures": detect_figures(document[page - 1])}
            else:
                current = document[page - 1]
                result = {"text": current.get_text(sort=True)}
                if image_path:
                    target = Path(image_path)
                    if not target.exists():
                        bounds = current.rect
                        if crop:
                            bounds = pymupdf.Rect(
                                crop["x"] * bounds.width, crop["y"] * bounds.height,
                                (crop["x"] + crop["width"]) * bounds.width,
                                (crop["y"] + crop["height"]) * bounds.height,
                            )
                        scale = min(4 if crop else 2, 2048 / max(bounds.width, bounds.height))
                        pixmap = current.get_pixmap(
                            matrix=pymupdf.Matrix(scale, scale), clip=bounds, alpha=False
                        )
                        target.parent.mkdir(parents=True, exist_ok=True)
                        temporary = target.with_suffix(".tmp")
                        temporary.write_bytes(pixmap.tobytes("jpeg", jpg_quality=85))
                        temporary.replace(target)
                    result["image_path"] = str(target)
            pipe.send((True, result))
    except Exception:
        pipe.send((False, "invalid_pdf"))
    finally:
        pipe.close()


class PdfService:
    def __init__(self, timeout, *, outline_timeout=120, outline_options=None):
        self.timeout = timeout
        self.outline_timeout = outline_timeout
        self.outline_options = outline_options or {}
        self.lock = asyncio.Semaphore(1)

    async def run(self, operation, path, page=1, image_path=None, crop=None):
        async with self.lock:
            context = multiprocessing.get_context("spawn")
            reader, writer = context.Pipe(duplex=False)
            process = context.Process(
                target=_worker,
                args=(writer, operation, str(path), page, image_path, self.outline_options, crop),
            )
            process.start()
            writer.close()
            deadline = time.monotonic() + (
                # Whole-document passes get the longer budget.
                self.outline_timeout if operation in {"outline", "texts"} else self.timeout
            )
            try:
                while not reader.poll():
                    if time.monotonic() >= deadline:
                        raise TimeoutError("pdf_timeout")
                    await asyncio.sleep(0.02)
                valid, result = reader.recv()
                if not valid:
                    raise ValueError(result)
                return result
            finally:
                # Cancellation kills the process before releasing the concurrency slot.
                if process.is_alive():
                    process.terminate()
                process.join(timeout=1)
                if process.is_alive():
                    process.kill()
                    process.join()
                reader.close()
