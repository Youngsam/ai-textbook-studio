import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pdf = execFileSync(`${root}/backend/.venv/bin/python`, [
  "-c",
  `
import pymupdf,sys
with pymupdf.open() as doc:
 for i in range(3):
  p=doc.new_page(width=900,height=1600)
  p.insert_text((60,80),f'Reference fixture page {i+1}')
  p.insert_text((60,270),'See Figure 2.17b')
  p.insert_text((60,970),'Figure detail and caption')
  p.insert_text((60,1020),'Same page reference')
 for i in range(3):
  p=doc[i]
  p.insert_link({'kind':pymupdf.LINK_GOTO,'from':pymupdf.Rect(55,250,190,280),'page':(i+1)%3,'to':pymupdf.Point(60,940)})
  p.insert_link({'kind':pymupdf.LINK_GOTO,'from':pymupdf.Rect(55,1000,200,1030),'page':i,'to':pymupdf.Point(60,200)})
  p.insert_link({'kind':pymupdf.LINK_URI,'from':pymupdf.Rect(55,300,190,330),'uri':'https://example.com/reference'})
  p.insert_link({'kind':pymupdf.LINK_GOTO,'from':pymupdf.Rect(55,350,190,380),'page':0,'to':pymupdf.Point(0,0)})
 data=doc.tobytes()
with pymupdf.open(stream=data,filetype='pdf') as doc:
 for p in doc:
  doc.xref_set_key(p.get_links()[-1]['xref'],'A','<</S/GoTo/D(missing.figure)>>')
 sys.stdout.buffer.write(doc.tobytes())
`,
]);

test.beforeEach(async ({ request }) => {
  expect((await (await request.get("/api/settings")).json()).provider).toBe(
    "fake",
  );
});

test("reference preview preserves reading state, navigates precisely and returns through same-page history", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const title = `References ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "새 책 추가", exact: true }).click();
  await page.getByLabel("PDF 파일", { exact: true }).setInputFiles({
    name: "references.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByLabel("책 제목").fill(title);
  await page.getByRole("button", { name: "학습 프로젝트 만들기" }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  const bookId = page.url().split("/").pop();
  const main = page.getByLabel("PDF 본문 페이지", { exact: true });
  const links = main.locator(".pdf-reference-link");
  await expect(links).toHaveCount(4);
  await page.getByRole("button", { name: "확대", exact: true }).click();
  await expect(main.locator(".pdf-paper")).toHaveCSS("visibility", "visible");
  const originalZoom = await page.locator(".zoom-controls span").textContent();
  await main.evaluate((e) => {
    e.scrollTop = 180;
    e.scrollLeft = 55;
  });
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/books/${bookId}/state`)).json())
          .scroll_offset,
    )
    .toBeGreaterThan(0);
  await expect(page.locator(".reader-save")).toContainText("저장됨");
  const saved = await (await request.get(`/api/books/${bookId}/state`)).json();
  const before = await main.evaluate((e) => ({
    top: e.scrollTop,
    left: e.scrollLeft,
  }));
  await expect(links.nth(2)).toHaveAttribute(
    "href",
    "https://example.com/reference",
  );
  await expect(links.nth(2)).toHaveAttribute("rel", "noopener noreferrer");
  await links.nth(3).click();
  await expect(page.locator(".reference-notice")).toContainText(
    "참조 위치를 찾지 못했습니다",
  );
  await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "1",
  );
  await page.getByRole("button", { name: "참조 안내 닫기" }).click();
  await links.nth(0).click();
  const dialog = page.getByRole("dialog", {
    name: "참조 미리보기",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("PDF 2쪽");
  await expect(dialog.locator(".textLayer")).toContainText("fixture page 2");
  await page.screenshot({
    path: `${root}/.cache/reference-preview-desktop.png`,
  });
  await page.getByRole("button", { name: "참조 확대", exact: true }).click();
  await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "1",
  );
  expect(
    await main.evaluate((e) => ({ top: e.scrollTop, left: e.scrollLeft })),
  ).toEqual(before);
  expect(
    await (await request.get(`/api/books/${bookId}/state`)).json(),
  ).toEqual(saved);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(links.nth(0)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".pdf-paper")).toHaveCSS("visibility", "visible");
  // A failed destination render must restore the source without committing history.
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: function () {
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
          value: original,
          configurable: true,
        });
        throw new Error("Simulated destination canvas failure");
      },
    });
  });
  await dialog.getByRole("button", { name: "해당 위치로 이동" }).click();
  await expect(page.locator(".reference-notice")).toContainText(
    "이전 위치로 돌아갑니다",
  );
  await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "1",
  );
  await expect(main.locator(".pdf-paper")).toHaveCSS("visibility", "visible");
  await expect(
    page.getByRole("button", { name: "참조 이동 전으로 돌아가기" }),
  ).toHaveCount(0);
  await expect
    .poll(() => main.evaluate((e) => e.scrollTop))
    .toBeCloseTo(before.top, 0);
  await page.getByRole("button", { name: "참조 안내 닫기" }).click();
  await links.nth(0).click();
  await dialog.getByRole("button", { name: "해당 위치로 이동" }).click();
  await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "2",
  );
  await expect(main.locator(".textLayer")).toContainText("fixture page 2");
  await expect(
    page.getByRole("button", { name: "참조 이동 전으로 돌아가기" }),
  ).toBeEnabled();
  await expect
    .poll(() => main.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(600);
  const pageTwo = await main.evaluate((e) => ({
    top: e.scrollTop,
    left: e.scrollLeft,
  }));
  // Same-page destination must execute even though page number and zoom are unchanged.
  await links.nth(1).click();
  await dialog.getByRole("button", { name: "해당 위치로 이동" }).click();
  await expect.poll(() => main.evaluate((e) => e.scrollTop)).toBeLessThan(400);
  // Continue to a third page, then restore both same-page and cross-page history.
  const samePagePosition = await main.evaluate((e) => e.scrollTop);
  await links.nth(0).click();
  await dialog.getByRole("button", { name: "해당 위치로 이동" }).click();
  await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "3",
  );
  await expect(main.locator(".pdf-paper")).toHaveCSS("visibility", "visible");
  await page.getByRole("button", { name: "확대", exact: true }).click();
  await expect(main.locator(".pdf-paper")).toHaveCSS("visibility", "visible");
  await page.getByRole("button", { name: "참조 이동 전으로 돌아가기" }).click();
  await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "2",
  );
  await expect
    .poll(() => main.evaluate((e) => e.scrollTop))
    .toBeCloseTo(samePagePosition, 0);
  await expect(page.locator(".zoom-controls span")).toHaveText(originalZoom!);
  await page.getByRole("button", { name: "참조 이동 전으로 돌아가기" }).click();
  await expect
    .poll(() => main.evaluate((e) => e.scrollTop))
    .toBeCloseTo(pageTwo.top, 0);
  await page.getByRole("button", { name: "참조 이동 전으로 돌아가기" }).click();
  await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "1",
  );
  await expect
    .poll(() => main.evaluate((e) => e.scrollTop))
    .toBeCloseTo(before.top, 0);
  expect(await main.evaluate((e) => e.scrollLeft)).toBeCloseTo(before.left, 0);
  await expect(
    page.getByRole("button", { name: "참조 이동 전으로 돌아가기" }),
  ).toHaveCount(0);
  // Existing text selection still reaches the assistant.
  await main
    .locator(".textLayer span")
    .first()
    .evaluate((e) => {
      const range = document.createRange();
      range.selectNodeContents(e);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await expect(page.locator(".selection-chip")).toContainText(
    "Reference fixture",
  );
  expect(errors).toEqual([]);
  await request.delete(`/api/books/${bookId}`);
});

test("mobile preview can close and leaves the main page untouched", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "새 책 추가", exact: true }).click();
  await page.getByLabel("PDF 파일", { exact: true }).setInputFiles({
    name: "mobile.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  const title = `Mobile links ${Date.now()}`;
  await page.getByLabel("책 제목").fill(title);
  await page.getByRole("button", { name: "학습 프로젝트 만들기" }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  const bookId = page.url().split("/").pop();
  await page
    .getByLabel("PDF 본문 페이지", { exact: true })
    .locator(".pdf-reference-link")
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "참조 미리보기",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".pdf-paper")).toHaveCSS("visibility", "visible");
  await page.getByLabel("참조 창 높이").fill("80");
  await page.screenshot({
    path: `${root}/.cache/reference-preview-mobile.png`,
    fullPage: true,
  });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await dialog.getByRole("button", { name: "참조 미리보기 닫기" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("현재 페이지", { exact: true })).toHaveValue(
    "1",
  );
  await request.delete(`/api/books/${bookId}`);
});
