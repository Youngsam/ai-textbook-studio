import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pdf = execFileSync(`${root}/backend/.venv/bin/python`, [
  "-c",
  `import pymupdf,sys
with pymupdf.open() as doc:
 for i in range(3):
  page=doc.new_page()
  page.insert_text((60,80),f'Page {i+1}: A vector has magnitude and direction.')
  page.insert_text((60,680),'A second passage near the bottom of the page.')
 sys.stdout.buffer.write(doc.tobytes())`,
]);

test("highlights and notes persist, filter, navigate, edit, and recover from save errors", async ({
  page,
  request,
  browser,
}) => {
  expect((await (await request.get("/api/settings")).json()).provider).toBe(
    "fake",
  );
  const uploaded = await request.post("/api/books", {
    multipart: {
      title: "나의 독서 기록 테스트",
      file: {
        name: "annotations.pdf",
        mimeType: "application/pdf",
        buffer: pdf,
      },
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  const book = await uploaded.json();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`/books/${book.id}`);
    const url = page.url();
    async function select(index = 0) {
      await expect(page.locator(".textLayer span").nth(index)).toBeVisible();
      await page
        .locator(".textLayer span")
        .nth(index)
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
      await expect(
        page.getByRole("toolbar", { name: "선택한 텍스트 기록" }),
      ).toBeVisible();
    }
    await select();
    await page
      .getByRole("button", { name: "노랑 하이라이트", exact: true })
      .click();
    await expect(page.locator(".pdf-highlight")).toHaveCount(1);
    await page.getByLabel("현재 페이지", { exact: true }).fill("2");
    await expect(page.locator(".textLayer")).toContainText("Page 2:");
    await select();
    await page.getByRole("button", { name: "주석", exact: true }).click();
    await page
      .getByLabel("나의 주석", { exact: true })
      .fill("벡터의 방향을 다시 복습하기");
    await page
      .getByRole("button", { name: "초록 하이라이트", exact: true })
      .click();
    await page.getByRole("button", { name: "내 기록 닫기" }).click();
    await page.getByRole("button", { name: "내 기록", exact: true }).click();
    await expect(page.getByLabel("나의 주석", { exact: true })).toHaveValue(
      "벡터의 방향을 다시 복습하기",
    );
    await page.route(`**/api/books/${book.id}/annotations`, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 503, json: { detail: "저장 테스트 오류" } })
        : route.continue(),
    );
    await page.getByRole("button", { name: "기록 저장", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("저장 테스트 오류");
    await expect(page.getByLabel("나의 주석", { exact: true })).toHaveValue(
      "벡터의 방향을 다시 복습하기",
    );
    await page.unroute(`**/api/books/${book.id}/annotations`);
    await page.getByRole("button", { name: "기록 저장", exact: true }).click();
    await expect(page.locator(".annotation-card")).toHaveCount(2);
    await page.getByRole("button", { name: "주석", exact: true }).click();
    await expect(page.locator(".annotation-card")).toHaveCount(1);
    await page.getByLabel("기록 검색").fill("복습");
    await expect(page.locator(".annotation-note")).toContainText("벡터의 방향");
    await page.getByLabel("기록 검색").fill("없는 검색어");
    await expect(page.getByText("일치하는 기록이 없습니다")).toBeVisible();
    await page.getByLabel("기록 검색").fill("");
    await page.getByRole("button", { name: "전체", exact: true }).click();
    await page.screenshot({ path: `${root}/.cache/annotations-desktop.png` });
    await page.locator(".annotation-quote").first().click();
    await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
      "1",
    );
    await expect(page.locator(".pdf-highlight.is-active")).toBeInViewport();
    await expect(
      page.getByRole("complementary", { name: "내 기록", exact: true }),
    ).toBeHidden();
    const before = await page.locator(".pdf-highlight").boundingBox();
    await page.getByRole("button", { name: "확대", exact: true }).click();
    await expect
      .poll(
        async () => (await page.locator(".pdf-highlight").boundingBox())?.width,
      )
      .toBeGreaterThan(before!.width);
    await expect(page.locator(".reader-save")).toContainText("저장됨");
    await page.reload();
    await expect(page.locator(".pdf-highlight")).toHaveCount(1);
    await page.getByRole("button", { name: "내 기록", exact: true }).click();
    await expect(page.locator(".annotation-card")).toHaveCount(2);
    const context = await browser.newContext();
    const second = await context.newPage();
    await second.goto(url);
    await second.getByRole("button", { name: "내 기록", exact: true }).click();
    await expect(second.locator(".annotation-card")).toHaveCount(2);
    await context.close();
    await page.getByLabel("기록 색상 필터").selectOption("green");
    await expect(page.locator(".annotation-card")).toHaveCount(1);
    await page.getByRole("button", { name: "PDF 2쪽 기록 편집" }).click();
    await page.getByLabel("나의 주석", { exact: true }).fill("수정한 주석");
    await page.getByRole("button", { name: "기록 저장", exact: true }).click();
    await expect(page.locator(".annotation-note")).toContainText("수정한 주석");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${root}/.cache/annotations-mobile.png` });
    await expect(page.getByLabel("기록 검색")).toBeInViewport();
    await page.getByRole("button", { name: "PDF 2쪽 기록 편집" }).click();
    await page.getByRole("button", { name: "기록 삭제", exact: true }).click();
    await page.getByRole("button", { name: "삭제", exact: true }).click();
    await expect(page.locator(".annotation-card")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/books/${book.id}`);
  }
});

test("marks stay selectable and locating a mark restores its scroll position", async ({
  page,
  request,
}) => {
  const uploaded = await request.post("/api/books", {
    multipart: {
      title: "기록 위치 테스트",
      file: { name: "position.pdf", mimeType: "application/pdf", buffer: pdf },
    },
  });
  const book = await uploaded.json();
  try {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto(`/books/${book.id}`);
    const line = page.locator(".textLayer span").nth(1);
    await expect(line).toBeVisible();
    await line.scrollIntoViewIfNeeded();
    const box = (await line.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(
      page.getByRole("toolbar", { name: "선택한 텍스트 기록" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "파랑 하이라이트", exact: true })
      .click();
    await expect(page.locator(".pdf-highlight")).toHaveCount(1);
    // Highlight paint must not prevent selecting the underlying text again.
    const marked = (await line.boundingBox())!;
    await page.mouse.move(marked.x + 2, marked.y + marked.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      marked.x + marked.width - 2,
      marked.y + marked.height / 2,
      { steps: 12 },
    );
    await page.mouse.up();
    await expect(
      page.getByRole("toolbar", { name: "선택한 텍스트 기록" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "선택 도구 닫기" }).click();
    await page
      .getByLabel("PDF 본문 페이지", { exact: true })
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    await expect(page.locator(".pdf-highlight")).not.toBeInViewport();
    await page.getByRole("button", { name: "내 기록", exact: true }).click();
    await page.locator(".annotation-quote").click();
    await expect(page.locator(".pdf-highlight.is-active")).toBeInViewport();
    await page.getByLabel("현재 페이지", { exact: true }).fill("2");
    await expect(page.locator(".textLayer")).toContainText("Page 2:");
    await page.getByRole("button", { name: "내 기록", exact: true }).click();
    await page.locator(".annotation-quote").click();
    await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
      "1",
    );
    await expect(page.locator(".pdf-highlight.is-active")).toBeInViewport();
    // Mouse hit testing opens the note editor while the overlay remains selectable.
    const highlight = (await page.locator(".pdf-highlight").boundingBox())!;
    await page.mouse.click(
      highlight.x + highlight.width / 2,
      highlight.y + highlight.height / 2,
    );
    await expect(page.getByLabel("나의 주석", { exact: true })).toBeVisible();
    await page
      .getByLabel("나의 주석", { exact: true })
      .fill("본문에서 연 주석");
    await page.getByRole("button", { name: "기록 저장", exact: true }).click();
    await expect(page.locator(".annotation-note")).toContainText(
      "본문에서 연 주석",
    );
  } finally {
    await request.delete(`/api/books/${book.id}`);
  }
});
