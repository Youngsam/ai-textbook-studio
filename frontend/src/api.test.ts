import { describe, expect, it } from "vitest";
import { parseSSE } from "./api";

describe("SSE parser", () => {
  it("preserves Korean UTF-8 and frames split across arbitrary byte boundaries", async () => {
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\n\r\nevent: delta\r\ndata: {"text":"안녕하세요"}\r\n\r\nevent: completed\ndata: {}\n\n',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 2)
          controller.enqueue(bytes.slice(i, i + 2));
        controller.close();
      },
    });
    const result = [];
    for await (const event of parseSSE(stream)) result.push(event);
    expect(result).toEqual([
      { event: "delta", data: { text: "안녕하세요" } },
      { event: "completed", data: {} },
    ]);
  });
  it("does not dispatch incomplete frames after abrupt EOF", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("event: completed\ndata: {}"),
        );
        controller.close();
      },
    });
    const result = [];
    for await (const event of parseSSE(stream)) result.push(event);
    expect(result).toEqual([]);
  });
});
