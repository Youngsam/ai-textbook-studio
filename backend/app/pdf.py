"""PDF work runs in a bounded child process; documents never cross process boundaries."""

import asyncio
import multiprocessing
import time
from pathlib import Path

import pymupdf


def _worker(pipe, operation, path, page, image_path):
    try:
        with pymupdf.open(path) as document:
            if document.needs_pass or not document.is_pdf or document.page_count < 1:
                raise ValueError("invalid_pdf")
            if operation == "inspect":
                result = {"page_count": document.page_count}
            else:
                current = document[page - 1]
                result = {"text": current.get_text(sort=True)}
                if image_path:
                    target = Path(image_path)
                    if not target.exists():
                        scale = min(2, 2048 / max(current.rect.width, current.rect.height))
                        pixmap = current.get_pixmap(
                            matrix=pymupdf.Matrix(scale, scale), alpha=False
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
    def __init__(self, timeout):
        self.timeout = timeout
        self.lock = asyncio.Semaphore(1)

    async def run(self, operation, path, page=1, image_path=None):
        async with self.lock:
            context = multiprocessing.get_context("spawn")
            reader, writer = context.Pipe(duplex=False)
            process = context.Process(
                target=_worker, args=(writer, operation, str(path), page, image_path)
            )
            process.start()
            writer.close()
            deadline = time.monotonic() + self.timeout
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
