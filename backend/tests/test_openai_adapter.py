import asyncio
import json
from unittest.mock import patch

import httpx
import pytest
from openai import AsyncOpenAI

from app.config import Settings
from app.llm import ChatContext, OpenAIAdapter


@pytest.mark.parametrize("selected_model", [None, "selected-model"])
def test_real_sdk_request_schema_and_stream_translation(selected_model):
    captured = {}

    def respond(request):
        captured.update(json.loads(request.content))
        frames = [
            {
                "type": "response.output_text.delta",
                "delta": "설명",
                "item_id": "item",
                "output_index": 0,
                "content_index": 0,
                "sequence_number": 0,
            },
            {
                "type": "response.completed",
                "sequence_number": 1,
                "response": {
                    "id": "response",
                    "object": "response",
                    "created_at": 0,
                    "model": "test-model",
                    "status": "completed",
                    "output": [],
                    "usage": {
                        "input_tokens": 20,
                        "output_tokens": 3,
                        "total_tokens": 23,
                        "input_tokens_details": {"cached_tokens": 0},
                        "output_tokens_details": {"reasoning_tokens": 0},
                    },
                },
            },
        ]
        data = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames)
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, content=data)

    async def run():
        client = AsyncOpenAI(
            api_key="test-only",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
        )
        settings = Settings(_env_file=None, OPENAI_API_KEY="test-only", LLM_MODEL="test-model")
        with patch("app.llm.AsyncOpenAI", return_value=client):
            return [
                event
                async for event in OpenAIAdapter(settings).stream(
                    ChatContext(
                        prompt="Synthetic page context",
                        history=[],
                        image_url="data:image/jpeg;base64,dGVzdA==",
                        style="concise",
                        model=selected_model,
                    )
                )
            ]

    result = asyncio.run(run())
    assert result[0] == {"type": "delta", "text": "설명"}
    assert result[-1]["usage"]["total_tokens"] == 23
    assert captured["store"] is False and captured["stream"] is True
    assert captured["model"] == (selected_model or "test-model")
    assert captured["input"][-1]["content"][-1]["type"] == "input_image"
