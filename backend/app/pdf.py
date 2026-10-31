"""PDF work runs in a bounded child process; documents never cross process boundaries."""

import asyncio
import json
import multiprocessing
import time
from pathlib import Path

import pymupdf

from app.outline import detect_outline

OUTLINE_CACHE_VERSION = 2


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
                self.outline_timeout if operation == "outline" else self.timeout
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
