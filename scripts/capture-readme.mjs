// Run from the repository root against an isolated LLM_PROVIDER=fake server.
// Example: STUDIO_SCREENSHOT_URL=http://127.0.0.1:8012 node scripts/capture-readme.mjs
import {
  chromium,
  expect,
} from "../frontend/node_modules/@playwright/test/index.mjs";
import { execFileSync } from "node:child_process";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: 1680, height: 1050 },
  deviceScaleFactor: 1,
});
const base = process.env.STUDIO_SCREENSHOT_URL || "http://127.0.0.1:8012";
const pdf = execFileSync("backend/.venv/bin/python", [
  "-c",
  `
import pymupdf,sys
with pymupdf.open() as doc:
 p=doc.new_page()
 p.draw_rect(pymupdf.Rect(45,45,550,100),color=None,fill=(0.94,0.96,0.91))
 def text(y,s,size=13,color=(0.2,0.25,0.2)):
  p.insert_text((60,y),s,fontname='korea',fontsize=size,color=color)
 text(78,'확률과 통계 · 학습 예제',22)
 text(140,'01  조건부 확률',19)
 text(182,'어떤 사건이 일어났다는 정보를 알게 되면,')
 text(208,'다른 사건의 확률도 달라질 수 있습니다.')
 text(255,'조건부 확률은 주어진 조건 안에서 계산한 확률입니다.')
 p.draw_rect(pymupdf.Rect(60,285,535,355),color=(0.8,0.85,0.75),fill=(0.97,0.98,0.95))
 p.insert_text((95,327),'P(A | B) = P(A and B) / P(B)',fontname='helv',fontsize=20,color=(0.2,0.36,0.28))
 text(395,'예제: 카드 10장 중 파란 카드가 4장 있습니다.',14)
 text(425,'파란 카드 4장 중 별이 그려진 카드는 3장입니다.')
 text(455,'파란 카드를 뽑았을 때, 별이 있을 확률은 얼마일까요?')
 text(520,'생각해 보기',16)
 text(554,'1. 조건에 맞는 카드는 몇 장인가요?')
 text(584,'2. 그중 별이 있는 카드는 몇 장인가요?')
 text(614,'3. 전체 카드가 아니라 조건 안에서 비율을 구해 보세요.')
 text(760,'AI Textbook Studio | 직접 작성한 공개용 예제',10)
 doc.set_toc([[1,'조건부 확률',1]])
 sys.stdout.buffer.write(doc.tobytes())
`,
]);
const consoleErrors = [];
page.on("pageerror", (error) => consoleErrors.push(error.message));
async function capture(name) {
  await page.mouse.move(1620, 1020);
  await expect(page.locator(".reader-save")).toContainText("저장됨");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/images/${name}.png` });
}
async function selectPassage(min, max) {
  await page.locator(".textLayer").evaluate(
    (el, { min, max }) => {
      const top = el.getBoundingClientRect().top;
      const spans = [...el.querySelectorAll("span")].filter((span) => {
        const y = span.getBoundingClientRect().top - top;
        return y > min && y < max;
      });
      if (!spans.length) throw new Error("Example passage not found");
      const range = document.createRange();
      range.setStartBefore(spans[0]);
      range.setEndAfter(spans.at(-1));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { min, max },
  );
  await expect(
    page.getByRole("toolbar", { name: "선택한 텍스트 기록" }),
  ).toBeVisible();
}
let book;
try {
  const settings = await (
    await page.request.get(`${base}/api/settings`)
  ).json();
  if (settings.provider !== "fake")
    throw new Error("Screenshots require a fake-provider demo server.");
  const response = await page.request.post(`${base}/api/books`, {
    multipart: {
      title: "확률과 통계 · 학습 예제",
      file: {
        name: "probability-demo.pdf",
        mimeType: "application/pdf",
        buffer: pdf,
      },
    },
  });
  if (response.status() !== 201) throw new Error("Upload failed");
  book = await response.json();
  await page.addInitScript(() => {
    localStorage.setItem("textbook-studio.chat-width", "460");
    localStorage.setItem("textbook-studio.chat-font-size", "15");
  });
  await page.goto(`${base}/books/${book.id}`);
  await expect(page.locator(".textLayer")).toContainText("조건부 확률");
  await page
    .getByLabel("질문", { exact: true })
    .fill("이 문장의 뜻을 카드 예제로 설명해 줘.");
  await selectPassage(235, 260);
  await expect(page.locator(".selection-chip")).toBeVisible();
  await capture("select-and-ask");
  // Capture the same formula as a region attachment, using the real selection UI.
  await page.getByRole("button", { name: "선택 문구 해제" }).click();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.getByRole("button", { name: "영역 선택", exact: true }).click();
  const bounds = await page.locator(".crop-overlay").boundingBox();
  if (!bounds) throw new Error("Region selection overlay not found");
  await page.mouse.move(bounds.x + 55, bounds.y + 280);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 540, bounds.y + 360);
  await page.mouse.up();
  await expect(page.locator(".crop-outline")).toBeVisible();
  await capture("select-region");
  await page.getByRole("button", { name: "질문에 추가" }).click();
  await expect(page.locator(".crop-attachment img")).toBeVisible();
  await page.getByLabel("질문", { exact: true }).fill("선택한 수식을 먼저 읽고, 분모가 P(B)인 이유를 설명해 줘.");
  await capture("region-attachment");
  const answer = `파란 카드라는 **조건에 맞는 카드만** 모아서 생각하면 됩니다.

- 전체 카드: 10장
- 파란 카드: 4장
- 그중 별이 있는 카드: 3장

조건이 주어졌으므로 분모는 10장이 아니라 **파란 카드 4장**입니다.

$$
P(별 \\mid 파랑) = \\frac{3}{4} = 75\\%
$$

~~~mermaid
flowchart LR
 A["전체 10장"] --> B["파란 카드 4장"]
 B --> C["별 카드 3장"]
~~~

**핵심:** 조건에 맞는 범위를 먼저 좁힌 뒤, 그 안에서 비율을 구합니다.`;
  const common = {
    page: 1,
    status: "completed",
    request_id: "readme-example",
    error_code: null,
    context_snapshot: {},
  };
  await page.route(`**/api/books/${book.id}/messages*`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            ...common,
            id: "demo-user",
            role: "user",
            selected_text:
              "조건부 확률은 주어진 조건 안에서 계산한 확률입니다.",
            content: "이 문장의 뜻을 카드 예제로 설명해 줘.",
          },
          {
            ...common,
            id: "demo-assistant",
            role: "assistant",
            selected_text: "",
            content: answer,
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.reload();
  await expect(page.locator(".diagram-svg svg")).toBeVisible();
  await expect(page.locator(".katex-display")).toHaveCount(1);
  await page.locator(".messages").evaluate((el) => (el.scrollTop = 0));
  await capture("explanation");
  // Save actual reading marks through the UI, so the screenshots show persisted records.
  await selectPassage(235, 260);
  await page.getByRole("button", { name: "주석", exact: true }).click();
  await page
    .getByRole("button", { name: "초록 하이라이트", exact: true })
    .click();
  await page
    .getByLabel("나의 주석", { exact: true })
    .fill(
      "조건이 주어지면 전체가 아니라 조건에 맞는 범위 안에서 생각하기. 카드 예제로 다시 복습하자.",
    );
  await page.getByRole("button", { name: "기록 저장", exact: true }).click();
  await expect(page.locator(".annotation-card")).toHaveCount(1);
  await page.getByRole("button", { name: "내 기록 닫기" }).click();
  await selectPassage(440, 460);
  await page
    .getByRole("button", { name: "노랑 하이라이트", exact: true })
    .click();
  await expect(page.locator(".annotation-toast")).toContainText("저장했습니다");
  await page.getByRole("button", { name: "내 기록", exact: true }).click();
  await expect(page.locator(".annotation-card")).toHaveCount(2);
  await expect(page.locator(".annotation-toast")).toHaveCount(0);
  await capture("highlights-and-notes");
  await page.getByRole("button", { name: "내 기록 닫기" }).click();
  await selectPassage(565, 590);
  await page.getByRole("button", { name: "주석", exact: true }).click();
  await page
    .getByRole("button", { name: "파랑 하이라이트", exact: true })
    .click();
  await page
    .getByLabel("나의 주석", { exact: true })
    .fill(
      "분모는 파란 카드 4장, 분자는 그중 별 카드 3장. 다음에는 조건이 달라지는 문제도 풀어 보기.",
    );
  await capture("add-note");
  if (consoleErrors.length) throw new Error(consoleErrors.join("\n"));
  console.log("Captured six README screenshots from the current app.");
} finally {
  if (book) await page.request.delete(`${base}/api/books/${book.id}`);
  await browser.close();
}
