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


@pytest.mark.parametrize(
    "provider,host,key_field",
    [
        ("claude", "api.anthropic.com", "anthropic_api_key"),
        ("gemini", "generativelanguage.googleapis.com", "gemini_api_key"),
        ("openrouter", "openrouter.ai", "openrouter_api_key"),
    ],
)
def test_compatible_sdk_routes_history_images_and_stream(provider, host, key_field):
    from app.llm import CompatibleAdapter

    captured = {}

    def respond(request):
        assert request.url.host == host
        assert request.headers["authorization"] == "Bearer provider-test-key"
        captured.update(json.loads(request.content))
        frames = [
            {
                "id": "x",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "custom",
                "choices": [{"index": 0, "delta": {"content": "설명"}, "finish_reason": None}],
            },
            {
                "id": "x",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "custom",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
            },
        ]
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=(
                "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"
            ),
        )

    async def run():
        settings = Settings(_env_file=None, **{key_field: "provider-test-key"})
        original = AsyncOpenAI

        def client_factory(**kwargs):
            return original(
                **kwargs,
                http_client=httpx.AsyncClient(
                    transport=httpx.MockTransport(respond),
                ),
            )

        with patch("app.llm.AsyncOpenAI", side_effect=client_factory):
            return [
                event
                async for event in CompatibleAdapter(settings, provider).stream(
                    ChatContext(
                        "page",
                        [{"role": "assistant", "content": "earlier answer"}],
                        "data:image/jpeg;base64,dGVzdA==",
                        "concise",
                        "custom",
                    )
                )
            ]

    result = asyncio.run(run())
    assert result[0] == {"type": "delta", "text": "설명"}
    assert result[-1]["usage"]["total_tokens"] == 7
    assert captured["model"] == "custom"
    assert captured["messages"][1]["content"] == "earlier answer"
    assert captured["messages"][-1]["content"][-1]["type"] == "image_url"


def test_fake_server_never_constructs_an_external_client():
    from app.llm import FakeAdapter, make_adapter

    settings = Settings(_env_file=None, llm_provider="fake")
    with patch("app.llm.AsyncOpenAI", side_effect=AssertionError("external client")):
        for provider in ("openai", "claude", "gemini", "openrouter"):
            assert isinstance(make_adapter(settings, provider), FakeAdapter)


def run_tool_recorder(calls):
    async def run_tool(name, arguments):
        calls.append((name, arguments))
        return '<page number="5">later definition</page>'

    return run_tool


def sse(frames, done=False):
    content = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames)
    return httpx.Response(
        200,
        headers={"Content-Type": "text/event-stream"},
        content=content + ("data: [DONE]\n\n" if done else ""),
    )


def test_responses_tool_loop_replays_call_and_output():
    requests, tool_calls = [], []
    usage = {
        "input_tokens": 10,
        "output_tokens": 2,
        "total_tokens": 12,
        "input_tokens_details": {"cached_tokens": 0},
        "output_tokens_details": {"reasoning_tokens": 0},
    }

    def completed(sequence):
        return {
            "type": "response.completed",
            "sequence_number": sequence,
            "response": {
                "id": "response",
                "object": "response",
                "created_at": 0,
                "model": "test-model",
                "status": "completed",
                "output": [],
                "usage": usage,
            },
        }

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            call = {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": "read_pages",
                "arguments": '{"start": 5, "end": 5}',
                "status": "completed",
            }
            return sse(
                [
                    {
                        "type": "response.output_item.done",
                        "item": call,
                        "output_index": 0,
                        "sequence_number": 0,
                    },
                    completed(1),
                ]
            )
        return sse(
            [
                {
                    "type": "response.output_text.delta",
                    "delta": "답",
                    "item_id": "item",
                    "output_index": 0,
                    "content_index": 0,
                    "sequence_number": 0,
                },
                completed(1),
            ]
        )

    async def run():
        client = AsyncOpenAI(
            api_key="test-only",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
        )
        settings = Settings(_env_file=None, OPENAI_API_KEY="test-only", LLM_MODEL="test-model")
        context = ChatContext(
            "page",
            [],
            None,
            "concise",
            tools=[{"name": "read_pages", "description": "d", "parameters": {"type": "object"}}],
            run_tool=run_tool_recorder(tool_calls),
        )
        with patch("app.llm.AsyncOpenAI", return_value=client):
            return [event async for event in OpenAIAdapter(settings).stream(context)]

    result = asyncio.run(run())
    assert tool_calls == [("read_pages", {"start": 5, "end": 5})]
    assert result[0] == {"type": "tool", "name": "read_pages", "arguments": {"start": 5, "end": 5}}
    assert result[-1]["usage"]["total_tokens"] == 24
    assert result[-1]["usage"]["input_tokens_details"] == {"cached_tokens": 0}
    assert requests[0]["tools"][0]["type"] == "function"
    replay = requests[1]["input"]
    assert replay[-2]["type"] == "function_call" and "id" not in replay[-2]
    assert replay[-1] == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": '<page number="5">later definition</page>',
    }


def test_compatible_tool_loop_and_forced_final_answer():
    from app.llm import CompatibleAdapter

    requests, tool_calls = [], []

    def chunk(delta, finish=None):
        return {
            "id": "x",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "custom",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        if body.get("tool_choice") == "none":
            return sse([chunk({"content": "최종"}), chunk({}, "stop")], done=True)
        fragments = [
            {
                "index": 0,
                "id": "call_1",
                "type": "function",
                "function": {"name": "search_book", "arguments": ""},
            },
            {"index": 0, "function": {"arguments": '{"query": '}},
            {"index": 0, "function": {"arguments": '"eigen"}'}},
        ]
        return sse(
            [chunk({"tool_calls": [fragment]}) for fragment in fragments]
            + [chunk({}, "tool_calls")],
            done=True,
        )

    async def run():
        settings = Settings(_env_file=None, anthropic_api_key="provider-test-key")
        original = AsyncOpenAI

        def client_factory(**kwargs):
            return original(
                **kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
            )

        context = ChatContext(
            "page",
            [],
            None,
            "concise",
            tools=[{"name": "search_book", "description": "d", "parameters": {"type": "object"}}],
            run_tool=run_tool_recorder(tool_calls),
            max_tool_rounds=1,
        )
        with patch("app.llm.AsyncOpenAI", side_effect=client_factory):
            return [event async for event in CompatibleAdapter(settings, "claude").stream(context)]

    result = asyncio.run(run())
    assert tool_calls == [("search_book", {"query": "eigen"})]
    assert [event["type"] for event in result] == ["tool", "delta", "done"]
    assert len(requests) == 2 and "tool_choice" not in requests[0]
    assistant, tool = requests[1]["messages"][-2:]
    assert assistant["tool_calls"][0]["function"]["arguments"] == '{"query": "eigen"}'
    assert tool == {
        "role": "tool",
        "tool_call_id": "call_1",
        "content": '<page number="5">later definition</page>',
    }
