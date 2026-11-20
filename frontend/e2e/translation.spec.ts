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
  page.insert_text((60,100),f'Page {i+1}. A vector has both magnitude and direction.')
 sys.stdout.buffer.write(doc.tobytes())`,
]);

for (const mobile of [false, true]) {
  test(`page translation replaces the page in place ${mobile ? "mobile" : "desktop"}`, async ({
    page,
    request,
  }) => {
    const settings = await (await request.get("/api/settings")).json();
    expect(settings.provider).toBe("fake");
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const response = await request.post("/api/books", {
      multipart: {
        title: "페이지 번역",
        file: { name: "vector.pdf", mimeType: "application/pdf", buffer: pdf },
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
      const toggle = page.locator(".translate-toggle");
      await expect(toggle).toHaveText("번역");
      await toggle.click();
      const view = page.locator(".translation-view");
      await expect(view).toContainText("테스트 번역");
      await expect(view).toContainText("1쪽 번역");
      await expect(toggle).toHaveText("원문 보기");
      await expect(
        page.getByRole("button", { name: "영역 선택", exact: true }),
      ).toBeDisabled();
      // The translated paper keeps the original page width, including after zoom.
      const pdfPaper = page.locator(
        ".pdf-reference-view > .pdf-scroll > .pdf-paper",
      );
      const paper = page.locator(".translation-paper");
      const widths = async () => [
        (await pdfPaper.boundingBox())!.width,
        (await paper.boundingBox())!.width,
      ];
      await expect
        .poll(async () => {
          const [original, translated] = await widths();
          return Math.abs(original - translated);
        })
        .toBeLessThan(1);
      const before = (await widths())[0];
      await page.getByRole("button", { name: "확대", exact: true }).click();
      await expect
        .poll(async () => {
          const [original, translated] = await widths();
          return original > before && Math.abs(original - translated) < 1;
        })
        .toBe(true);
      await page.getByRole("button", { name: "축소", exact: true }).click();
      await page.waitForTimeout(300);
      await page.screenshot({
        path: `${root}/.cache/translation-${mobile ? "mobile" : "desktop"}.png`,
      });

      // The shortcut flips between the original and the cached translation.
      await page.keyboard.press("t");
      await expect(view).toHaveCount(0);
      await expect(toggle).toHaveText("번역 보기");
      await page.keyboard.press("t");
      await expect(view).toBeVisible();

      // Turning the page returns to the original; the new page is untranslated.
      await page
        .getByRole("button", { name: "PDF 오른쪽 다음 페이지" })
        .click();
      await expect(view).toHaveCount(0);
      await expect(toggle).toHaveText("번역");
      await page.getByRole("button", { name: "PDF 왼쪽 이전 페이지" }).click();
      await expect(toggle).toHaveText("번역 보기");
      await expect(view).toHaveCount(0);
    } finally {
      await request.delete(`/api/books/${book.id}`);
    }
  });
}

test("translation model is chosen separately in AI settings", async ({
  page,
  request,
}) => {
  const original = await (await request.get("/api/settings")).json();
  expect(original.provider).toBe("fake");
  const response = await request.post("/api/books", {
    multipart: {
      title: "번역 모델",
      file: { name: "vector.pdf", mimeType: "application/pdf", buffer: pdf },
    },
  });
  const book = await response.json();
  try {
    await page.goto(`/books/${book.id}`);
    await expect(page.locator(".textLayer span").first()).toBeVisible();
    await page.getByRole("button", { name: "AI 설정" }).click();
    const panel = page.locator(".translation-settings");
    await expect(panel).toContainText("설명 모델과 같음");
    await expect(panel.getByLabel("번역 모델")).toHaveCount(0);
    await panel.getByLabel("번역 제공업체").selectOption("fake");
    const save = panel.getByRole("button", { name: "번역 설정 저장" });
    await expect(save).toBeDisabled();
    await panel.getByLabel("번역 모델").fill(" translate-e2e ");
    await save.click();
    await expect(panel).toContainText("번역 모델을 저장했습니다.");
    await expect(panel).toContainText("현재: fake · translate-e2e");
    await page.screenshot({ path: `${root}/.cache/translation-settings.png` });

    await page.locator(".translate-toggle").click();
    await expect(page.locator(".translation-view")).toContainText(
      "1쪽 번역 · translate-e2e",
    );
    // The explanation model is unaffected by the translation choice.
    const saved = await (await request.get("/api/settings")).json();
    expect(saved.model).toBe(original.model);

    await panel.getByLabel("번역 제공업체").selectOption("");
    await save.click();
    await expect(panel).toContainText("현재: 설명 모델과 같음");
  } finally {
    await request.put("/api/settings", {
      data: { translation_provider: "", translation_model: "" },
    });
    await request.delete(`/api/books/${book.id}`);
  }
});

const figurePdf = execFileSync(`${root}/backend/.venv/bin/python`, [
  "-c",
  `import pymupdf,sys
with pymupdf.open() as doc:
 page=doc.new_page()
 page.insert_text((60,80),'Figure 1.1 shows how returns are distributed.')
 for i in range(5):
  page.draw_rect(pymupdf.Rect(100+i*60,200,140+i*60,420-i*30),fill=(0.2,0.4,0.8))
 page.insert_text((60,450),'Figure 1.1 Distribution of returns.')
 sys.stdout.buffer.write(doc.tobytes())`,
]);

test("translated page reuses figures cropped from the original", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/books", {
    multipart: {
      title: "그림 재활용",
      file: {
        name: "figure.pdf",
        mimeType: "application/pdf",
        buffer: figurePdf,
      },
    },
  });
  const book = await response.json();
  try {
    await page.goto(`/books/${book.id}`);
    await expect(page.locator(".textLayer span").first()).toBeVisible();
    await page.locator(".translate-toggle").click();
    const figure = page.locator(".translation-view img.translation-figure");
    await expect(figure).toBeVisible();
    await expect
      .poll(() =>
        figure.evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
    // The crop keeps its share of the page width in the translated column.
    const [figureBox, paperBox] = [
      (await figure.boundingBox())!,
      (await page.locator(".translation-paper").boundingBox())!,
    ];
    expect(figureBox.width / paperBox.width).toBeGreaterThan(0.4);
    expect(figureBox.width / paperBox.width).toBeLessThan(0.6);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${root}/.cache/translation-figure.png` });
  } finally {
    await request.delete(`/api/books/${book.id}`);
  }
});
