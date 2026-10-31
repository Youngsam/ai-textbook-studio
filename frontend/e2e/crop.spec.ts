import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pdf = execFileSync(`${root}/backend/.venv/bin/python`, [
  "-c",
  `import pymupdf,sys
with pymupdf.open() as doc:
 for i in range(2):
  page=doc.new_page()
  page.insert_text((60,100),'Matrix A = [1 2; 3 4]. Explain the determinant of this matrix.')
 sys.stdout.buffer.write(doc.tobytes())`,
]);

for (const mobile of [false, true]) {
  test(`crop attaches original page image ${mobile ? "mobile" : "desktop"}`, async ({
    page,
    request,
  }) => {
    const originalSettings = await (await request.get("/api/settings")).json();
    expect(originalSettings.provider).toBe("fake");
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const response = await request.post("/api/books", {
      multipart: {
        title: "행렬 영역 선택",
        file: { name: "matrix.pdf", mimeType: "application/pdf", buffer: pdf },
      },
    });
    const book = await response.json();
    try {
      await page.goto(`/books/${book.id}`);
      await expect(page.locator(".textLayer span").first()).toBeVisible();
      const toolbar = page.locator(".reader-toolbar");
      expect(
        await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBeTruthy();
      await page
        .getByRole("button", { name: "영역 선택", exact: true })
        .click();
      const overlay = page.locator(".crop-overlay");
      await expect(overlay).toBeVisible();
      if (mobile) {
        // Keyboard path also supports selection without a precise drag gesture.
        await overlay.press("ArrowRight");
        await overlay.press("Shift+ArrowDown");
        for (let i = 0; i < 12; i++) await overlay.press("ArrowUp");
      } else {
        const bounds = (await overlay.boundingBox())!;
        await page.mouse.move(bounds.x + 50, bounds.y + 70);
        await page.mouse.down();
        await page.mouse.move(bounds.x + 430, bounds.y + 140);
        await page.mouse.up();
      }
      await page.screenshot({
        path: `${root}/.cache/crop-${mobile ? "mobile" : "desktop"}-selection.png`,
      });
      await page.getByRole("button", { name: "질문에 추가" }).click();
      await expect(page.locator(".crop-attachment img")).toBeVisible();
      await expect(overlay).toHaveCount(0);
      await page.getByLabel("현재 페이지", { exact: true }).fill("2");
      await expect(page.locator(".context-chip")).toContainText("PDF 1쪽");
      await page.getByRole("button", { name: "AI 설정", exact: true }).click();
      await page.getByLabel("페이지 이미지").selectOption("never");
      await expect(page.getByLabel("페이지 이미지")).toHaveValue("never");
      await expect(page.getByLabel("페이지 이미지")).toBeEnabled();
      await page.getByRole("button", { name: "AI 설정", exact: true }).click();
      await page
        .getByLabel("질문", { exact: true })
        .fill("선택한 행렬을 설명해 주세요");
      await page.screenshot({
        path: `${root}/.cache/crop-${mobile ? "mobile" : "desktop"}-attachment.png`,
      });
      const sent = page.waitForRequest(
        (req) =>
          req.url().endsWith(`/books/${book.id}/chat`) &&
          req.method() === "POST",
      );
      await page.getByRole("button", { name: "질문 보내기" }).click();
      const payload = (await sent).postDataJSON();
      expect(payload.page).toBe(1);
      expect(payload.crop.width).toBeGreaterThan(0.1);
      expect(payload.image_mode).toBe("never");
      await expect(
        page.getByText("페이지 이미지도 첨부되었습니다.", { exact: false }),
      ).toBeVisible();
      await expect(page.locator(".crop-attachment")).toHaveCount(0);
      await page
        .getByRole("button", { name: "영역 선택", exact: true })
        .click();
      await page.locator(".crop-overlay").press("Escape");
      await expect(page.locator(".crop-overlay")).toHaveCount(0);
    } finally {
      await request.delete(`/api/books/${book.id}`);
      await request.put("/api/settings", { data: originalSettings });
    }
  });
}
