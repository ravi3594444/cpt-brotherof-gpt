// Real-browser smoke checks for sample mode. Needs no keys and no network.
//
//   pnpm dev                                   # in one terminal
//   node scripts/browser-smoke.mjs [base-url]  # defaults to http://localhost:5173/
//
// Uses Playwright from this project or a global install (npm i -g playwright).
// Set SMOKE_SCREENSHOTS=<dir> to save screenshots.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

function loadPlaywright() {
  for (const base of [import.meta.url, execSync("npm root -g").toString().trim() + "/"]) {
    try {
      return createRequire(base)("playwright");
    } catch {
      // Try the next location.
    }
  }
  console.error("Playwright is not installed. Run: npm i -g playwright && npx playwright install chromium");
  process.exit(2);
}
const { chromium } = loadPlaywright();
const BASE = process.argv[2] || "http://localhost:5173/";
const SHOTS = process.env.SMOKE_SCREENSHOTS;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
async function open(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // Web fonts may be blocked in sandboxes; that is not an app error.
    if (m.type() === "error" && !/fonts\.(googleapis|gstatic)|ERR_CERT|net::ERR/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".try-demo");
  return { context, page, errors };
}
// An answer is finished when its follow-up chips (or an error) appear.
const finished = (page) => page.waitForSelector(".followup, .error-banner", { timeout: 20000 });
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

try {
  {
    const { context, page, errors } = await open();
    const bodies = [];
    page.on("request", (r) => r.url().endsWith("/api/chat") && bodies.push(JSON.parse(r.postData())));
    await page.getByRole("button", { name: /Try a sample research question/ }).click();
    await finished(page);
    const text = await page.locator(".conversation").innerText();
    check("sample question streams a complete answer", /prepared example/.test(text));
    check("sample answer shows 3 source cards", (await page.locator(".source-card").count()) === 3);
    check("research activity completes", /Sample research complete/.test(text));
    const body = bodies[0] || {};
    check(
      "request sends web, sample and engine choices with text-only turns",
      body.webEnabled === true && body.preview === true && body.engine === "auto" &&
        body.messages?.every((m) => m.parts.every((p) => p.type === "text")),
      JSON.stringify(body).slice(0, 300),
    );
    const popup = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.locator('.answer-body button[data-streamdown="link"]').first().click();
    check("clicking a citation opens its source page", !!(await popup));
    await shot(page, "sample-answer");

    await page.locator(".followup").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".answer-actions").length === 2, null, { timeout: 20000 }).catch(() => {});
    await finished(page);
    check("a follow-up suggestion produces a second answer", (await page.locator(".answer-actions").count()) === 2);

    await page.reload({ waitUntil: "networkidle" });
    const titles = await page.locator(".scout-sidebar .history-item span").allInnerTexts();
    check("the conversation is in the sidebar after a reload", titles.some((t) => /AI agents search the web/.test(t)), titles.join(" | "));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    const { context, page, errors } = await open();
    await page.getByRole("button", { name: /Explore a research example/ }).click();
    const ok = await finished(page).then(() => true, () => false);
    check("sidebar research example streams an answer", ok);
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    const { context, page } = await open();
    const bodies = [];
    page.on("request", (r) => r.url().endsWith("/api/chat") && bodies.push(JSON.parse(r.postData())));
    await page.getByRole("switch", { name: "Search the web" }).click();
    await page.getByRole("button", { name: /Preview an image source card/ }).click();
    await finished(page);
    const answer = await page.locator(".answer-body").innerText();
    check("web-off request says webEnabled: false", bodies[0]?.webEnabled === false);
    check("web-off sample answer has no leftover citation text", !/\.jpg\)|\]\(|\[\d\]/.test(answer), JSON.stringify(answer.slice(0, 160)));
    await context.close();
  }
  {
    const { context, page } = await open();
    await page.getByRole("button", { name: /Preview an image source card/ }).click();
    await finished(page);
    check("image source card shows its picture", (await page.locator(".source-card img.source-image").count()) === 1);
    await context.close();
  }
  {
    const { context, page } = await open();
    let calls = 0;
    await page.route("**/api/chat", (route) =>
      ++calls === 1 ? route.fulfill({ status: 503, body: "The research service is busy." }) : route.fallback(),
    );
    await page.getByRole("button", { name: /Try a sample research question/ }).click();
    await page.waitForSelector(".error-banner", { timeout: 20000 });
    check("a failed request shows its error", /research service is busy/.test(await page.locator(".error-banner").innerText()));
    await page.getByRole("button", { name: "Try again" }).click();
    await page.waitForSelector(".followup", { timeout: 20000 });
    check("Try again answers without repeating the question", (await page.locator(".user-message").count()) === 1,
      `${await page.locator(".user-message").count()} copies of the question`);
    await context.close();
  }
  for (const [width, height] of [[1280, 720], [1366, 640], [1280, 800], [390, 844], [360, 640]]) {
    const { context, page } = await open({ width, height });
    await shot(page, `home-${width}x${height}`);
    const layout = await page.evaluate(() => {
      const area = document.querySelector(".empty-workspace");
      const top = document.querySelector(".welcome-symbol").getBoundingClientRect().top;
      area.scrollTop = area.scrollHeight;
      const last = [...document.querySelectorAll(".try-demo")].at(-1).getBoundingClientRect();
      const box = area.getBoundingClientRect();
      return {
        headerHidden: top < box.top,
        lastButtonReachable: last.bottom <= box.bottom + 1,
        sideScroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    check(`${width}x${height}: welcome is fully visible or scrollable, no side scroll`,
      !layout.headerHidden && layout.lastButtonReachable && !layout.sideScroll, JSON.stringify(layout));
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll browser checks passed");
process.exit(failures ? 1 : 0);
