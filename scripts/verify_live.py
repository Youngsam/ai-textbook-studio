"""Opt-in live API smoke test with synthetic text and image-only PDFs."""

import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import pymupdf
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient


def synthetic_pdfs():
    with pymupdf.open() as source:
        page = source.new_page()
        page.insert_text(
            (70, 90),
            "A vector has two properties: magnitude and direction.",
            fontsize=18,
        )
        text_pdf = source.tobytes()
        image = page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5))
        with pymupdf.open() as scanned:
            scanned.new_page().insert_image(page.rect, pixmap=image)
            return [("text", text_pdf), ("scan", scanned.tobytes())]


def main():
    with TemporaryDirectory() as temporary:
        settings = Settings(
            data_dir=temporary,
            database_url=f"sqlite:///{temporary}/live.db",
            llm_provider="openai",
        )
        settings.llm_max_output_tokens = 512
        if not settings.llm_configured:
            sys.exit("OPENAI_API_KEY와 LLM_MODEL이 필요합니다.")
        with TestClient(create_app(settings)) as client:
            for kind, document in synthetic_pdfs():
                result = client.post(
                    "/api/books",
                    data={"title": f"Synthetic {kind}"},
                    files={"file": ("generated.pdf", document, "application/pdf")},
                )
                assert result.status_code == 201, f"{kind}: upload failed"
                book_id = result.json()["id"]
                response = client.post(
                    f"/api/books/{book_id}/chat",
                    json={
                        "request_id": str(uuid4()),
                        "question": "이 페이지에서 벡터의 두 속성은 무엇인가요? 한 문장으로 답하세요.",
                        "page": 1,
                        "image_mode": "auto",
                        "response_style": "concise",
                    },
                )
                assert response.status_code == 200, f"{kind}: chat rejected"
                message = client.get(f"/api/books/{book_id}/messages").json()["items"][
                    -1
                ]
                assert message["status"] == "completed", (
                    f"{kind}: {message['error_code']}"
                )
                assert message["content"].strip(), f"{kind}: empty answer"
                assert message["context_snapshot"]["image_attached"] == (kind == "scan")
                assert message["usage"]["input_tokens"] > 0
                print(
                    json.dumps(
                        {
                            "kind": kind,
                            "model": settings.llm_model,
                            "status": message["status"],
                            "image_attached": message["context_snapshot"][
                                "image_attached"
                            ],
                            "input_tokens": message["usage"]["input_tokens"],
                            "output_tokens": message["usage"]["output_tokens"],
                        }
                    )
                )


if __name__ == "__main__":
    main()
