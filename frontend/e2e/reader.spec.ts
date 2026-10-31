import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test.beforeAll(async ({ request }) => {
  const response = await request.get("/api/settings");
  expect(
    (await response.json()).provider,
    "브라우저 테스트는 LLM_PROVIDER=fake 서버에서만 실행합니다.",
  ).toBe("fake");
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = `${root}/backend/.venv/bin/python`;
const pdf = execFileSync(python, [
  "-c",
  `import pymupdf,sys
with pymupdf.open() as doc:
 for i in range(130):
  page=doc.new_page()
  page.insert_text((60,80),f'Linear algebra page {i+1}: A vector has magnitude and direction.')
  page.insert_text((60,110),'Select this passage to ask a question about the current page.')
 sys.stdout.buffer.write(doc.tobytes())`,
]);

test("upload, PDF selection, question, restore, another device, and confirmed deletion", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const title = `Browser test ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "새 책 추가", exact: true }).click();
  await page.getByLabel("PDF 파일", { exact: true }).setInputFiles({
    name: "generated.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByLabel("책 제목").fill(title);
  await page.getByRole("button", { name: "학습 프로젝트 만들기" }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page.locator(".textLayer")).toContainText("magnitude");
  await page.getByLabel("현재 페이지", { exact: true }).fill("127");
  await expect(page.locator(".textLayer")).toContainText("page 127:");
  // Select real PDF.js text nodes; the UI must capture the selection on mouseup.
  await page
    .locator(".textLayer span")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await expect(page.locator(".selection-chip")).toContainText("magnitude");
  await page.getByLabel("질문", { exact: true }).fill("Explain vectors");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await expect(page.locator(".message.assistant")).toContainText("테스트 응답");
  await expect(page.getByRole("button", { name: "답변 중단" })).toHaveCount(0);
  await expect(page.locator(".reader-save")).toContainText("저장됨");
  await page.route("**/api/books/*/state", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { detail: "temporary failure" } })
      : route.continue(),
  );
  await page.getByLabel("현재 페이지", { exact: true }).fill("128");
  await expect(page.locator(".reader-save")).toContainText("저장 실패");
  await page.unroute("**/api/books/*/state");
  await page
    .locator(".reader-save")
    .getByRole("button", { name: "재시도" })
    .click();
  await expect(page.locator(".reader-save")).toContainText("저장됨");
  await page.getByLabel("현재 페이지", { exact: true }).fill("127");
  await expect(page.locator(".textLayer")).toContainText("page 127:");
  await expect(page.locator(".reader-save")).toContainText("저장됨");
  await expect(page.locator(".privacy-note")).toBeInViewport();
  await expect(page.locator(".reader-footer")).toBeInViewport();
  await page.screenshot({ path: `${root}/.cache/qa-reader.png` });
  const bookUrl = page.url();
  await page.reload();
  await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "127",
  );
  await expect(page.locator(".message.assistant")).toContainText("테스트 응답");
  const context = await browser.newContext({
    viewport: { width: 1100, height: 800 },
  });
  const second = await context.newPage();
  await second.goto(bookUrl);
  await expect(second.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "127",
  );
  await expect(second.locator(".message.assistant")).toContainText(
    "테스트 응답",
  );
  await context.close();
  await page.getByRole("button", { name: "내 서재" }).click();
  await page
    .getByRole("button", { name: `${title} 삭제`, exact: true })
    .click();
  await page.getByRole("button", { name: "모두 삭제", exact: true }).click();
  await expect(
    page.getByRole("link", { name: title, exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${root}/.cache/qa-library.png` });
  expect(errors).toEqual([]);
});

test("mobile layout and empty-state navigation stay usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "새 책 추가", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("scanned page automatically includes an image in the question", async ({
  page,
}) => {
  const scan = execFileSync(python, [
    "-c",
    `import pymupdf,sys
with pymupdf.open() as doc:
 page=doc.new_page()
 image=pymupdf.Pixmap(pymupdf.csRGB,pymupdf.IRect(0,0,60,60),False)
 image.clear_with(180)
 page.insert_image(pymupdf.Rect(30,30,200,200),pixmap=image)
 sys.stdout.buffer.write(doc.tobytes())`,
  ]);
  const result = await page.request.post("/api/books", {
    multipart: {
      title: "Scanned test",
      file: { name: "scan.pdf", mimeType: "application/pdf", buffer: scan },
    },
  });
  expect(result.status()).toBe(201);
  const book = await result.json();
  try {
    await page.goto(`/books/${book.id}`);
    await expect(page.locator(".pdf-paper")).toBeVisible();
    await page.getByLabel("질문", { exact: true }).fill("Explain the image");
    await page.getByRole("button", { name: "질문 보내기" }).click();
    await expect(page.locator(".message.assistant")).toContainText(
      "페이지 이미지도 첨부되었습니다.",
    );
    await expect(page.getByRole("button", { name: "답변 중단" })).toHaveCount(
      0,
    );
  } finally {
    await page.request.delete(`/api/books/${book.id}`);
  }
});

test("reader side controls, model selection, panel resize, and rich explanations", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const result = await page.request.post("/api/books", {
    multipart: {
      title: "Reader improvements",
      file: { name: "generated.pdf", mimeType: "application/pdf", buffer: pdf },
    },
  });
  const book = await result.json();
  expect(result.status()).toBe(201);
  try {
    await page.goto(`/books/${book.id}`);
    await expect(page.locator(".pdf-paper")).toBeVisible();
    const previous = page.getByRole("button", { name: "PDF 왼쪽 이전 페이지" });
    const next = page.getByRole("button", { name: "PDF 오른쪽 다음 페이지" });
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
      "2",
    );
    await previous.click();
    await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
      "1",
    );
    await page.getByLabel("현재 페이지", { exact: true }).fill("130");
    await expect(next).toBeDisabled();
    await expect(page.locator(".reader-save")).toContainText("저장됨");

    await page.getByRole("button", { name: "AI 설정" }).click();
    await page.getByLabel("설명 모델").fill("gpt-5.4");
    await page.getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/settings")).json()).model,
      )
      .toBe("gpt-5.4");
    await page.reload();
    await page.getByRole("button", { name: "AI 설정" }).click();
    await expect(page.getByLabel("설명 모델")).toHaveValue("gpt-5.4");
    await page.getByRole("button", { name: "AI 설정" }).click();

    const separator = page.getByRole("separator", {
      name: "학습 도우미 너비 조절",
    });
    const initialWidth = (await page.locator(".chat-panel").boundingBox())!
      .width;
    const handle = (await separator.boundingBox())!;
    const boundary = (await page.locator(".chat-panel").boundingBox())!;
    await page.mouse.move(boundary.x + 1, handle.y + handle.height / 2);
    await expect(separator).toHaveCSS("cursor", /url\(.+\) 12 12, ew-resize/);
    expect(
      await separator.evaluate(async (element) => {
        const url =
          getComputedStyle(element).cursor.match(/url\("([^"]+)"\)/)![1];
        const image = new Image();
        image.src = url;
        await image.decode();
        return image.naturalWidth;
      }),
    ).toBe(24);
    expect(
      await separator.evaluate((element) => element.matches(":hover")),
    ).toBe(true);
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.className,
        { x: boundary.x + 1, y: handle.y + handle.height / 2 },
      ),
    ).toBe("panel-resizer");
    await page.mouse.move(boundary.x + 1, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 120, handle.y + handle.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect
      .poll(
        async () => (await page.locator(".chat-panel").boundingBox())!.width,
      )
      .toBeGreaterThan(initialWidth + 100);
    const resized = (await page.locator(".chat-panel").boundingBox())!.width;
    await page.reload();
    await expect
      .poll(
        async () => (await page.locator(".chat-panel").boundingBox())!.width,
      )
      .toBe(resized);
    await separator.focus();
    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute(
      "aria-valuenow",
      String(resized - 20),
    );

    await expect(
      page.getByRole("slider", { name: "학습 도우미 너비", exact: true }),
    ).toHaveCount(0);
    const adjustedWidth = resized - 20;
    await page
      .getByRole("button", { name: "도우미 글자 확대", exact: true })
      .click();
    await expect(
      page.getByLabel("도우미 글자 크기", { exact: true }),
    ).toHaveText("13px");
    await expect(page.getByLabel("질문", { exact: true })).toHaveCSS(
      "font-size",
      "13px",
    );
    await page.reload();
    await expect(separator).toHaveAttribute(
      "aria-valuenow",
      String(adjustedWidth),
    );
    await expect(page.getByLabel("질문", { exact: true })).toHaveCSS(
      "font-size",
      "13px",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page
        .locator(".chat-header")
        .getByRole("button", { name: "도우미 글자 확대", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "도우미 글자 확대", exact: true })
      .click();
    await expect(page.getByLabel("질문", { exact: true })).toHaveCSS(
      "font-size",
      "14px",
    );
    await page
      .getByRole("button", { name: "도우미 글자 크기 초기화", exact: true })
      .click();
    await expect(page.getByLabel("질문", { exact: true })).toHaveCSS(
      "font-size",
      "12px",
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(separator).toHaveAttribute(
      "aria-valuenow",
      String(adjustedWidth),
    );

    const answer = String.raw`조건부 확률은 \(p(y_2 \mid y_1)\) 입니다.

\[
p(y_2 \mid y_1) = \frac{p(y_1,y_2)}{p(y_1)}
\]

~~~mermaid
flowchart LR
  A["현재 페이지"] --> B["문맥 이해"]
  B --> C["질문과 설명"]
~~~

~~~mermaid
this is not a valid diagram
~~~

<img src=x onerror="window.testInjection=true">`;
    await page.route(`**/api/books/${book.id}/messages*`, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "rich-answer",
              role: "assistant",
              content: answer,
              page: 130,
              selected_text: "",
              status: "completed",
              request_id: "synthetic",
              error_code: null,
              context_snapshot: {},
            },
          ],
          next_cursor: null,
        },
      }),
    );
    await page.reload();
    await expect(page.locator(".message .katex")).toHaveCount(2);
    await expect(page.locator(".katex-display")).toHaveCount(1);
    await expect(page.locator(".diagram-svg svg")).toBeVisible();
    await expect(page.locator(".diagram-svg svg")).toContainText("현재 페이지");
    await expect(
      page.getByText("다이어그램을 표시할 수 없습니다 · 원문 보기"),
    ).toBeVisible();
    expect(await page.evaluate(() => "testInjection" in window)).toBe(false);
    await expect(page.locator(".messages img")).toHaveCount(0);
    await page.screenshot({ path: `${root}/.cache/qa-improvements.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(separator).toBeHidden();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/books/${book.id}`);
    await page.request.put("/api/settings", {
      data: {
        model: "gpt-5.4-mini",
        response_style: "step_by_step",
        image_mode: "auto",
      },
    });
  }
});

test("outline navigation, favicon, and provider model testing", async ({
  page,
}) => {
  const initial = await (await page.request.get("/api/settings")).json();
  const outlined = execFileSync(python, [
    "-c",
    `import pymupdf,sys
with pymupdf.open() as doc:
 for i in range(3):
  doc.new_page().insert_text((60,80),f'Outline page {i+1}')
 doc.set_toc([[1,'Introduction',1],[2,'Vectors',3]])
 sys.stdout.buffer.write(doc.tobytes())`,
  ]);
  const response = await page.request.post("/api/books", {
    multipart: {
      title: "Outline settings test",
      file: {
        name: "outline.pdf",
        mimeType: "application/pdf",
        buffer: outlined,
      },
    },
  });
  expect(response.status()).toBe(201);
  const book = await response.json();
  try {
    await page.goto(`/books/${book.id}`);
    const favicon = await page.request.get("/favicon.svg");
    expect(favicon.headers()["content-type"]).toContain("image/svg+xml");
    await page.locator(".outline-control summary").click();
    await page.getByRole("button", { name: "Vectors 3쪽" }).click();
    await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
      "3",
    );
    await expect(page.locator(".outline-menu")).toBeHidden();
    await expect(page.locator(".reader-save")).toContainText("저장됨");
    await page.reload();
    await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
      "3",
    );
    await page.getByRole("button", { name: "AI 설정" }).click();
    await page.getByLabel("제공업체", { exact: true }).selectOption("gemini");
    await page.getByLabel("설명 모델").fill("custom-gemini-model");
    await page.route("**/api/settings/test", async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        provider: "gemini",
        model: "custom-gemini-model",
      });
      await route.fulfill({
        json: { ok: true, message: "텍스트 응답을 확인했습니다." },
      });
    });
    await page
      .getByRole("button", { name: "연결 테스트", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "텍스트 응답" }),
    ).toBeVisible();
    expect(
      (await (await page.request.get("/api/settings")).json()).provider,
    ).toBe("fake");
    await page.getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "모델을 저장" }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "AI 설정" }).click();
    await expect(page.getByLabel("제공업체", { exact: true })).toHaveValue(
      "gemini",
    );
    await expect(page.getByLabel("설명 모델")).toHaveValue(
      "custom-gemini-model",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".outline-control summary").click();
    await expect(
      page.getByRole("navigation", { name: "PDF 목차" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Vectors 3쪽" }),
    ).toBeVisible();
    await page.screenshot({ path: `${root}/.cache/qa-outline-mobile.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  } finally {
    await page.request.put("/api/settings", { data: initial });
    await page.request.delete(`/api/books/${book.id}`);
  }
});

test("scanned contents requires page calibration, navigates, and remembers calibration", async ({
  page,
  request,
}) => {
  const scannedContents = execFileSync(python, [
    "-c",
    `import pymupdf,sys
with pymupdf.open() as doc:
 page=doc.new_page()
 page.insert_text((50,55),'Contents',fontsize=20)
 for i,title in enumerate(['1 Introduction','1.1 Vector spaces','2 Transformations']):
  page.insert_text((50,120+i*35),title,fontsize=13)
  page.insert_text((500,120+i*35),str(i*2+1),fontsize=13)
 pix=page.get_pixmap(matrix=pymupdf.Matrix(2,2))
 doc.delete_page(0)
 page=doc.new_page()
 page.insert_image(page.rect,pixmap=pix)
 for i in range(8):
  page=doc.new_page()
  page.insert_text((50,100),'This chapter explains vector spaces and linear transformations.')
 sys.stdout.buffer.write(doc.tobytes(deflate=True))`,
  ]);
  const response = await request.post("/api/books", {
    multipart: {
      title: `Scan contents ${Date.now()}`,
      file: {
        name: "contents.pdf",
        mimeType: "application/pdf",
        buffer: scannedContents,
      },
    },
  });
  expect(response.status()).toBe(201);
  const book = await response.json();
  try {
    await page.goto(`/books/${book.id}`);
    await page.locator(".outline-control summary").click();
    const menu = page.getByRole("navigation", { name: "PDF 목차" });
    const chapter = menu.getByRole("button", { name: /Vector spaces/ });
    await expect(chapter).toBeDisabled();
    const correction = menu.getByLabel("쪽수 보정 (PDF − 인쇄)");
    await correction.fill("999");
    await expect(chapter).toBeDisabled();
    await correction.fill("1");
    await expect(chapter).toBeEnabled();
    await expect(chapter).toContainText("PDF 4");
    await page.screenshot({ path: `${root}/.cache/qa-contents.png` });
    await chapter.click();
    await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
      "4",
    );
    await expect(page.locator(".reader-save")).toContainText("저장됨");
    await page.reload();
    await page.locator(".outline-control summary").click();
    await expect(correction).toHaveValue("1");
    await correction.fill("-1");
    await expect(
      menu.getByRole("button", { name: /Introduction/ }),
    ).toBeDisabled();
    await expect(chapter).toContainText("PDF 2");
    await correction.fill("");
    await expect(chapter).toBeDisabled();
  } finally {
    await request.delete(`/api/books/${book.id}`);
  }
});
