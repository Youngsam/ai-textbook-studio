export type Book = {
  id: string;
  title: string;
  author: string;
  page_count: number;
  current_page: number;
  progress: number;
  last_opened_at: string;
  status: string;
};
export type ReadingState = {
  page: number;
  zoom: number;
  scroll_offset: number;
};
export type Preferences = {
  response_style: "step_by_step" | "concise";
  image_mode: "auto" | "always" | "never";
  model: string;
};
export type Settings = Preferences & {
  provider: string;
  model: string;
  available_models: string[];
  llm_configured: boolean;
  supports_images: boolean;
  max_upload_bytes: number;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  page: number;
  selected_text: string;
  status: string;
  request_id: string;
  error_code: string | null;
  context_snapshot: { image_attached?: boolean; truncated?: boolean };
};
export type Page<T> = { items: T[]; next_cursor: string | null };

export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${url}`, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    throw new Error(
      typeof detail === "string"
        ? detail
        : (detail?.message ?? `요청에 실패했습니다 (${response.status}).`),
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export type StreamEvent = { event: string; data: Record<string, unknown> };

// The decoder preserves partial UTF-8 characters and SSE frames between network chunks.
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let line = "";
  let event = "message";
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      // Split on LF, trim the CR only once a whole line has arrived.
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        line = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        if (line === "") {
          if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
          event = "message";
          data = [];
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function streamChat(
  url: string,
  body: object | undefined,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
) {
  const response = await fetch(`/api${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail?.message ?? "질문을 보내지 못했습니다.");
  }
  if (!response.body) throw new Error("응답 스트림이 없습니다.");
  let terminal = false;
  for await (const event of parseSSE(response.body)) {
    onEvent(event);
    if (event.event === "completed" || event.event === "failed")
      terminal = true;
  }
  if (!terminal)
    throw new Error("답변 연결이 중단되었습니다. 저장된 이력을 확인해 주세요.");
}
