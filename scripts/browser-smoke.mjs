// Real-browser smoke checks for sample mode. Needs no keys and no network.
//
//   pnpm dev                                   # in one terminal
//   node scripts/browser-smoke.mjs [base-url]  # defaults to http://localhost:5173/
//
// Uses Playwright from this project or a global install (npm i -g playwright).
// Set SMOKE_SCREENSHOTS=<dir> to save screenshots.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { crc32, deflateSync } from "node:zlib";

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
const PHONE = { width: 412, height: 915 };
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
};

const browser = await chromium.launch();
async function open(viewport = { width: 1280, height: 800 }, options = {}) {
  const context = await browser.newContext({ viewport, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // Web fonts may be blocked in sandboxes; that is not an app error.
    if (m.type() === "error" && !/fonts\.(googleapis|gstatic)|ERR_CERT|net::ERR/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  // The logo intro covers the page for about 1.5 s after every load.
  await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
  await page.waitForSelector(".suggestion-chip");
  return { context, page, errors };
}
const chip = (page, text) => page.locator(".suggestion-chip", { hasText: text });
const webChip = (page) => page.getByRole("button", { name: "Search the web", exact: true });
async function menuItem(page, role, name) {
  await page.getByRole("button", { name: "More options" }).click();
  return page.getByRole(role, { name });
}
// An answer is finished when its follow-up chips (or an error) appear.
const finished = (page) => page.waitForSelector(".followup, .error-banner", { timeout: 20000 });
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
// A UI message stream like /api/chat's, for answers the samples do not cover.
const stream = (chunks) => ({
  status: 200,
  headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
  body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
});
// Runs in the page: /api/chat answers stay open until the test sends their chunks with
// window.__answers[question].send(chunk) and .end(). Each starts like the server's, with
// the answer model still thinking.
function heldAnswers() {
  window.__answers = {};
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if ((typeof input === "string" ? input : input.url) !== "/api/chat") return realFetch(input, init);
    const question = JSON.parse(init.body).messages.at(-1).parts.find((p) => p.type === "text")?.text;
    const encoder = new TextEncoder();
    const answer = (window.__answers[question] = { aborted: false });
    const body = new ReadableStream({
      start(controller) {
        answer.send = (chunk) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        answer.end = () => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
        init.signal?.addEventListener("abort", () => {
          answer.aborted = true;
          controller.error(init.signal.reason);
        });
        answer.send({ type: "start", messageId: crypto.randomUUID(), messageMetadata: { demo: false } });
      },
    });
    return Promise.resolve(new Response(body, {
      headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
    }));
  };
}
// Runs in the page: watches the last Answer on screen and records anything that shows it restarting
// or jumping back: words that got fewer, and research steps or source cards replaced by fewer, both
// in every change to the page (`dom`) and in the frames the reader sees (`painted`); and the
// Reconnecting note. Starts at once, or when the page has loaded.
function watchAnswer() {
  const start = () => {
    const tracker = () => {
      const out = { shrank: [], steps: [], sources: [] };
      let last = { text: 0, steps: 0, sources: 0 };
      return {
        out,
        see({ text, steps, sources }) {
          if (text < last.text) out.shrank.push(`${last.text} to ${text}`);
          if (steps && steps < last.steps) out.steps.push(`${last.steps} to ${steps}`);
          if (sources < last.sources) out.sources.push(`${last.sources} to ${sources}`);
          last = { text, steps: steps || last.steps, sources };
        },
      };
    };
    const dom = tracker();
    const painted = tracker();
    const seen = (window.__watch = { dom: dom.out, painted: painted.out, reconnecting: 0, longest: 0 });
    const measure = () => {
      const answer = [...document.querySelectorAll(".assistant-message")].at(-1);
      if (!answer) return;
      return {
        text: answer.querySelector(".answer-body")?.textContent.length ?? 0,
        steps: answer.querySelectorAll(".agent-steps li").length,
        sources: answer.querySelectorAll(".source-card").length,
      };
    };
    const sample = () => {
      if ([...document.querySelectorAll(".progress-strip")].some((s) => /Reconnecting/.test(s.textContent))) seen.reconnecting++;
      const now = measure();
      if (!now) return;
      dom.see(now);
      seen.longest = Math.max(seen.longest, now.text);
    };
    const frame = () => {
      const now = measure();
      if (now) painted.see(now);
      requestAnimationFrame(frame);
    };
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true });
    sample();
    requestAnimationFrame(frame);
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
}
const LIVE_CONFIG = {
  access: "open", demo: false, modelConnected: true, searchConnected: true, modelName: "Test model",
  engines: { browserUse: false, kernel: true, visionAgent: false, tavily: false, jev: false, vision: false },
};
async function openHeld({ viewport = { width: 1280, height: 800 }, config = () => LIVE_CONFIG } = {}) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(heldAnswers);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/config", (route) => route.fulfill({ json: config() }));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
  return { context, page, errors };
}
async function askHeld(page, question) {
  await page.getByRole("textbox").fill(question);
  await page.getByRole("textbox").press("Enter");
  await page.waitForFunction((q) => window.__answers[q], question);
}
const sendHeld = (page, question, chunks, end = false) => page.evaluate(({ question, chunks, end }) => {
  chunks.forEach(window.__answers[question].send);
  if (end) window.__answers[question].end();
}, { question, chunks, end });
const writeText = (text) => [
  { type: "text-start", id: "a" },
  { type: "text-delta", id: "a", delta: text },
];
const finishText = [
  { type: "text-end", id: "a" },
  { type: "data-suggestions", data: ["Tell me more"] },
  { type: "finish", finishReason: "stop" },
];
const conversationItem = (page, title) => page.locator(".scout-sidebar .history-item", { hasText: title });
const answering = (page, title) => conversationItem(page, title).getByRole("img", { name: "Still answering" });
// A solid-colour PNG, for attaching photos without fixture files.
function png(width, height, [r, g, b]) {
  const row = Buffer.alloc(width * 3 + 1);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const photoFile = (name, w, h, rgb) => ({ name, mimeType: "image/png", buffer: png(w, h, rgb) });
async function addPhotos(page, files) {
  const chooser = page.waitForEvent("filechooser");
  await (await menuItem(page, "menuitem", "Add photos")).click();
  await (await chooser).setFiles(files);
}
const imageSize = (page, url) => page.evaluate(async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  return { width: img.naturalWidth, height: img.naturalHeight };
}, url);
const pixel = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="5"><rect width="8" height="5" fill="#8a6"/></svg>');

// Access code mode: run against a server started with SCOUT_ACCESS_CODE set,
//   SMOKE_ACCESS_CODE=<the code> node scripts/browser-smoke.mjs <base-url>
async function accessChecks(code) {
  const ask = (headers) => fetch(new URL("/api/chat", BASE), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ preview: true, messages: [{ role: "user", parts: [{ type: "text", text: "How do AI agents search the web?" }] }] }),
  });
  check("the chat API refuses a request without the access code", (await ask({})).status === 401);
  check("  and one with a wrong code", (await ask({ "x-scout-access": `${code}x` })).status === 401);
  const allowed = await ask({ "x-scout-access": code });
  check("  and answers one with the right code", allowed.status === 200 && /text-delta/.test(await allowed.text()));
  const locked = await (await fetch(new URL("/api/config", BASE))).json();
  check("the config API reveals nothing without the code", locked.access === "required" && !locked.modelConnected && !locked.searchConnected);

  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  const introGone = () => page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
  const gate = () => page.getByRole("heading", { name: "Enter your access code" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await introGone();
  check("the app asks for the access code first", (await gate()) && (await page.locator(".suggestion-chip").count()) === 0);
  await shot(page, "access-gate");
  await page.getByLabel("Access code").fill("not-the-code");
  await page.getByRole("button", { name: "Continue" }).click();
  check("  a wrong code is refused with a message",
    await page.getByText("That code isn't right").waitFor({ timeout: 5000 }).then(() => true, () => false));
  await page.getByLabel("Access code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  check("  the right code opens Scout", await page.waitForSelector(".suggestion-chip", { timeout: 5000 }).then(() => true, () => false));
  await page.reload({ waitUntil: "networkidle" });
  await introGone();
  check("  and is remembered on this device", await page.waitForSelector(".suggestion-chip", { timeout: 5000 }).then(() => true, () => false));
  const sent = [];
  page.on("request", (r) => r.url().endsWith("/api/chat") && sent.push(r.headers()["x-scout-access"]));
  await chip(page, "AI agents search the web").click();
  await finished(page);
  check("questions carry the code and get answers",
    sent[0] === code && /prepared example/.test(await page.locator(".conversation").innerText()), JSON.stringify(sent));
  await page.getByRole("button", { name: "Sample", exact: true }).click();
  await page.getByRole("button", { name: "Forget" }).click();
  check("Forget in the workspace settings locks Scout again", await gate());
  await context.close();
}
if (process.env.SMOKE_ACCESS_CODE) {
  try {
    await accessChecks(process.env.SMOKE_ACCESS_CODE);
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll access checks passed");
  process.exit(failures ? 1 : 0);
}

try {
  {
    // Logo intro: plays on load, gets out of the way, and a tap skips it.
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: "commit" });
    const shown = await page.waitForSelector(".logo-reveal", { state: "visible", timeout: 3000 }).then(() => true, () => false);
    check("the logo intro plays when the app opens", shown);
    await shot(page, "intro");
    // CSS fades it out on schedule even before the app's JavaScript loads,
    // so check what the user sees rather than when the element is removed.
    const gone = await page.waitForSelector(".logo-reveal", { state: "hidden", timeout: 4000 }).then(() => true, () => false);
    check("  and gets out of the way by itself", gone);
    await page.reload({ waitUntil: "domcontentloaded" });
    // The intro marks itself skippable once the app has loaded.
    await page.waitForSelector(".logo-reveal[data-skippable]", { timeout: 3000 }).catch(() => {});
    const wasShowing = await page.locator(".logo-reveal").isVisible();
    const tappedAt = Date.now();
    await page.mouse.click(200, 400);
    const skipped = await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 1500 }).then(() => true, () => false);
    check("  a tap skips it", wasShowing && skipped && Date.now() - tappedAt < 1500);
    await context.close();
  }
  {
    const { context, page } = await open(PHONE, { reducedMotion: "reduce" });
    check("with reduce motion on, there is no intro", (await page.locator(".logo-reveal").count()) === 0);
    await context.close();
  }
  {
    // Minimal home, like ChatGPT.
    const { context, page } = await open(PHONE);
    await shot(page, "home-phone");
    const home = await page.evaluate(() => ({
      heading: document.querySelector("h1")?.innerText.trim(),
      chips: document.querySelectorAll(".suggestion-chip").length,
      extras: [".welcome-subtitle", ".suggestion-grid", ".try-demo", ".footer-note", ".research-caption"]
        .filter((s) => document.querySelector(s)),
    }));
    check("home shows one heading, the question box and 3 suggestion chips",
      home.heading === "What do you want to research?" && home.chips === 3 && !home.extras.length, JSON.stringify(home));
    const box = await page.locator(".composer").boundingBox();
    check("on phones the question box sits at the bottom", box && PHONE.height - (box.y + box.height) < 48, JSON.stringify(box));
    const pressed = await webChip(page).getAttribute("aria-pressed");
    const sample = await (await menuItem(page, "menuitemcheckbox", "Sample answers")).getAttribute("aria-checked");
    check("the + menu shows Sample answers on, and the Web chip is on", pressed === "true" && sample === "true", `${pressed} ${sample}`);
    await shot(page, "menu-phone");
    await context.close();
  }
  {
    const { context, page, errors } = await open();
    const bodies = [];
    page.on("request", (r) => r.url().endsWith("/api/chat") && bodies.push(JSON.parse(r.postData())));
    await chip(page, "AI agents search the web").click();
    await finished(page);
    const text = await page.locator(".conversation").innerText();
    check("sample question streams a complete answer", /prepared example/.test(text));
    check("sample answer shows 3 source cards", (await page.locator(".source-card").count()) === 3);
    check("research activity completes", /Sample research complete/.test(text));
    check("  its steps fold away once the answer is done", !(await page.locator(".agent-steps").isVisible()));
    await page.getByRole("button", { name: /Sample research complete/ }).click();
    check("  and open again with a tap", await page.locator(".agent-steps").isVisible());
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
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
    const titles = await page.locator(".scout-sidebar .history-item span").allInnerTexts();
    check("the conversation is in the sidebar after a reload", titles.some((t) => /AI agents search the web/.test(t)), titles.join(" | "));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // Only prepared examples have a research trail; small talk just gets the Sample reply.
    const { context, page, errors } = await open(PHONE);
    await page.getByRole("textbox").fill("hey");
    await page.getByRole("textbox").press("Enter");
    await finished(page);
    check("in Sample mode, \"hey\" gets a reply and no research panel",
      /This is sample mode/.test(await page.locator(".answer-body").innerText()) &&
        (await page.locator(".agent-activity").count()) === 0 && (await page.locator(".source-card").count()) === 0);
    await page.locator(".followup", { hasText: "How do AI agents search the web?" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".answer-actions").length === 2, null, { timeout: 20000 }).catch(() => {});
    await finished(page);
    const trail = page.locator(".assistant-message").nth(1).locator(".agent-activity");
    check("  an example question still shows its research trail",
      (await trail.count()) === 1 && /Sample research complete/.test(await trail.innerText()));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // Live, web on: the model answered without calling the research tool.
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.route("**/api/config", (route) => route.fulfill({ json: {
      access: "open", demo: false, modelConnected: true, searchConnected: true, modelName: "Atria Dawn Preview",
      engines: { browserUse: false, kernel: true, visionAgent: false, tavily: false, jev: false, vision: false },
    } }));
    let release;
    const answered = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/chat", async (route) => {
      await answered;
      await route.fulfill(stream([
        { type: "start", messageId: "direct-1", messageMetadata: { demo: false } },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Hi! What would you like me to look into?" },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: "stop" },
      ]));
    });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
    await page.getByRole("textbox").fill("hey");
    await page.getByRole("textbox").press("Enter");
    const waiting = await page.locator(".progress-strip").innerText({ timeout: 5000 }).catch(() => "");
    check("with web on, the live waiting line says Thinking…, not research", /Thinking…/.test(waiting) && !/research/i.test(waiting), waiting);
    release();
    await page.waitForSelector(".answer-actions", { timeout: 10000 });
    const answer = await page.locator(".assistant-message").innerText();
    check("  a direct answer shows no research panel and no \"Research stopped\"",
      (await page.locator(".agent-activity").count()) === 0 && !/Research stopped/.test(answer) &&
        /What would you like me to look into/.test(answer) &&
        (await page.locator(".answer-stamp").innerText()) === "Scout", answer);
    await context.close();
  }
  {
    // Live research that failed but reached the model, research that kept partial results,
    // then research that failed on both of its tries.
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/config", (route) => route.fulfill({ json: {
      access: "open", demo: false, modelConnected: true, searchConnected: true, modelName: "Atria Dawn Preview",
      engines: { browserUse: true, kernel: false, visionAgent: false, tavily: false, jev: false, vision: false },
    } }));
    const reason = "The browser agent ran out of time before it reached a usable page. Try a narrower question or choose Kernel.";
    const partial = "The browser agent ran out of time; these are the pages it had reached";
    const task = "best shirts on shein";
    const retryTask = "best rated men's linen shirts on us.shein.com";
    const steps = ["Atria Dawn Preview started research: “best shirts on shein”", "Selected Browser Use Cloud", "Browser agent is visiting pages"];
    const research = (data) => ({ type: "data-research", id: "research", data: { queries: [task], demo: false, steps, ...data } });
    const didNotFinish = `Research did not finish: ${reason}`;
    const answer = (text) => [
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: text },
      { type: "text-end", id: "answer" },
      { type: "finish", finishReason: "stop" },
    ];
    const replies = [
      [
        { type: "start", messageId: "failed-1", messageMetadata: { demo: false } },
        research({ phase: "reading", sources: [], engine: "browser_use" }),
        research({ phase: "writing", sources: [], warning: reason, failed: true, steps: [...steps, didNotFinish] }),
        ...answer("The research ran out of time, so this is not from sources: linen shirts are a safe pick."),
      ],
      [
        { type: "start", messageId: "partial-1", messageMetadata: { demo: false } },
        research({ phase: "reading", sources: [], engine: "browser_use" }),
        research({
          phase: "complete", engine: "browser_use", warning: partial,
          sources: [{ title: "Men's Shirts | SHEIN USA", url: "https://us.shein.com/Men-Shirts-c-1979.html", content: "Top rated: a linen shirt." }],
        }),
        ...answer("A linen shirt is top rated [1](https://us.shein.com/Men-Shirts-c-1979.html)."),
      ],
      [
        { type: "start", messageId: "failed-twice", messageMetadata: { demo: false } },
        research({
          phase: "writing", sources: [], warning: reason, failed: true, queries: [task, retryTask],
          steps: [...steps, didNotFinish, `Atria Dawn Preview started research again: “${retryTask}”`, "Selected Browser Use Cloud", didNotFinish],
        }),
        ...answer("Research did not finish twice, so this is not from sources."),
      ],
    ];
    let asked = 0;
    await page.route("**/api/chat", (route) => route.fulfill(stream(replies[Math.min(asked++, replies.length - 1)])));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
    await page.getByRole("textbox").fill("find me some best shirts on shein");
    await page.getByRole("textbox").press("Enter");
    await page.waitForSelector(".answer-actions", { timeout: 10000 });
    const failed = page.locator(".assistant-message").nth(0).locator(".agent-activity");
    const failedText = await failed.innerText();
    check("research that failed but reached the model says \"Research incomplete\" with the reason",
      /Research incomplete/.test(failedText) && failedText.includes(reason) && !/Research stopped/.test(failedText), failedText);
    check("  the reason is on its own line, not cut off",
      await failed.locator(".activity-warning", { hasText: "ran out of time" }).isVisible(), failedText);
    await failed.locator(".activity-line").click();
    const failedStep = failed.locator(".agent-steps li", { hasText: "Research did not finish" });
    check("  the step for the try that did not finish has no check mark",
      await failedStep.locator("svg.step-failed").count() === 1 && await failedStep.locator("svg.lucide-check").count() === 0,
      await failed.innerHTML());
    await shot(page, "research-incomplete-phone");
    await page.getByRole("textbox").fill("try again, men's linen shirts");
    await page.getByRole("textbox").press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".answer-actions").length === 2, null, { timeout: 10000 }).catch(() => {});
    const kept = page.locator(".assistant-message").nth(1).locator(".agent-activity");
    const keptText = await kept.innerText();
    check("  partial results say Research complete and show the warning line",
      /Research complete/.test(keptText) && await kept.locator(".activity-warning", { hasText: partial }).isVisible(), keptText);
    await page.getByRole("textbox").fill("shein linen shirts please");
    await page.getByRole("textbox").press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".answer-actions").length === 3, null, { timeout: 10000 }).catch(() => {});
    const twice = page.locator(".assistant-message").nth(2).locator(".agent-activity");
    const twiceDetail = await twice.locator(".activity-detail").innerText().catch(() => "");
    check("  research that failed twice says Research incomplete and shows the second try's task",
      /Research incomplete/.test(await twice.innerText()) && twiceDetail === retryTask, twiceDetail);
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // Thinking: a live reasoning model thinks before it answers, streamed one chunk at a time.
    const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
    await context.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      const encode = (text) => new TextEncoder().encode(text);
      window.__chats = [];
      window.fetch = (input, init) => {
        if (!String(input.url || input).endsWith("/api/chat")) return realFetch(input, init);
        let body;
        const stream = new ReadableStream({ start: (controller) => { body = controller; } });
        window.__chats.push({
          request: JSON.parse(init.body),
          send: (chunk) => body.enqueue(encode(`data: ${JSON.stringify(chunk)}\n\n`)),
          end: () => { body.enqueue(encode("data: [DONE]\n\n")); body.close(); },
        });
        return Promise.resolve(new Response(stream, {
          headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
        }));
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && !/fonts\.(googleapis|gstatic)|ERR_CERT|net::ERR/.test(m.text())) errors.push(m.text());
    });
    await page.route("**/api/config", (route) => route.fulfill({ json: {
      access: "open", demo: false, modelConnected: true, searchConnected: true, modelName: "Atria Dawn Preview",
      engines: { browserUse: false, kernel: true, visionAgent: false, tavily: false, jev: false, vision: false },
    } }));
    const send = (...chunks) => page.evaluate((list) => list.forEach((c) => window.__chats.at(-1).send(c)), chunks);
    const end = () => page.evaluate(() => window.__chats.at(-1).end());
    const ask = async (question) => {
      const asked = await page.evaluate(() => window.__chats.length);
      await page.getByRole("textbox").fill(question);
      await page.getByRole("textbox").press("Enter");
      await page.waitForFunction((n) => window.__chats.length > n, asked);
    };
    const row = (n) => page.locator(".assistant-message").nth(n).locator(".thinking");
    const toggle = (n) => row(n).locator(".thinking-line");
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});

    await ask("hey");
    const early = await page.locator(".progress-strip").innerText();
    await page.waitForTimeout(3300);
    const late = await page.locator(".progress-strip").innerText();
    check("before the first chunk the waiting line says Thinking…, and elapsed seconds after 3 s",
      /^Thinking…$/.test(early.trim()) && /Thinking…\s*[3-9] s/.test(late), JSON.stringify({ early, late }));

    const thought = "The user says hey.\nNo research is needed. <b>Not bold</b>";
    await send(
      { type: "start", messageId: "think-1", messageMetadata: { demo: false } },
      { type: "reasoning-start", id: "thinking-1" },
      { type: "reasoning-delta", id: "thinking-1", delta: thought },
    );
    await row(0).waitFor({ timeout: 5000 });
    const streaming = await toggle(0).evaluate((el) => ({
      text: el.innerText,
      expanded: el.getAttribute("aria-expanded"),
      shimmer: getComputedStyle(el.querySelector(".thinking-label")).animationName,
      waiting: document.querySelectorAll(".progress-strip").length,
    }));
    check("while the model thinks, one collapsed row says Thinking… with a shimmer",
      /^Thinking…/.test(streaming.text) && streaming.expanded === "false" && streaming.shimmer === "thinking-shimmer" &&
        streaming.waiting === 0, JSON.stringify(streaming));
    await page.emulateMedia({ reducedMotion: "reduce" });
    const still = await row(0).locator(".thinking-label").evaluate((el) => getComputedStyle(el).animationName);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    check("  with reduce motion on, it does not shimmer", still === "none", still);
    const counted = await toggle(0).innerText().then(async (first) => {
      await page.waitForTimeout(1300);
      return { first, later: await toggle(0).innerText() };
    });
    check("  and counts the seconds", /Thinking…\s*[1-9] s/.test(counted.later), JSON.stringify(counted));
    await shot(page, "thinking-streaming-360");

    await send(
      { type: "message-metadata", messageMetadata: { thinkingMs: 2400 } },
      { type: "reasoning-end", id: "thinking-1" },
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: "Hi! What would you like me to look into?" },
      { type: "text-end", id: "answer" },
      { type: "finish", finishReason: "stop" },
    );
    await end();
    await page.waitForSelector(".answer-actions", { timeout: 10000 });
    const done = await toggle(0).evaluate((el) => ({ text: el.innerText, expanded: el.getAttribute("aria-expanded") }));
    const answer = await page.locator(".answer-body").first().innerText();
    check("when it is done the row says Thought for N s, still collapsed",
      /^Thought for 2 s/.test(done.text) && done.expanded === "false" && (await row(0).locator(".thinking-text").count()) === 0,
      JSON.stringify(done));
    check("  and the answer text has none of the thinking",
      /What would you like me to look into/.test(answer) && !/user says hey|No research|Not bold/.test(answer), answer);
    await toggle(0).click();
    const opened = await row(0).evaluate((el) => {
      const box = el.querySelector(".thinking-text");
      const style = box && getComputedStyle(box);
      return {
        expanded: el.querySelector(".thinking-line").getAttribute("aria-expanded"),
        text: box?.innerText,
        html: !!box?.querySelector("b"),
        scrolls: style?.overflowY === "auto" && style?.maxHeight !== "none",
        width: el.getBoundingClientRect().right <= innerWidth,
        sideScroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    check("  a tap shows the thinking as plain text, with its line breaks, in a scrolling box",
      opened.expanded === "true" && opened.text === thought && !opened.html && opened.scrolls, JSON.stringify(opened));
    check("  it fits a 360 px phone without scrolling sideways", opened.width && !opened.sideScroll, JSON.stringify(opened));
    await shot(page, "thinking-open-360");

    await ask("And the weather?");
    check("thinking in history is never sent back to the model",
      (await page.evaluate(() => window.__chats.at(-1).request.messages))
        .every((m) => m.parts.every((p) => p.type === "text")));
    await send(
      { type: "start", messageId: "plain-1", messageMetadata: { demo: false } },
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: "It is sunny." },
    );
    // A long answer, streamed after the reader opened the last Thinking row.
    for (let i = 1; i <= 6; i++) {
      await send({ type: "text-delta", id: "answer", delta: `\n\n${"Clear skies all afternoon, with a light breeze. ".repeat(6)}(${i})` });
      await page.waitForTimeout(120);
    }
    await send({ type: "text-end", id: "answer" }, { type: "finish", finishReason: "stop" });
    await end();
    await page.waitForFunction(() => document.querySelectorAll(".answer-actions").length === 2, null, { timeout: 10000 });
    check("an answer without thinking shows no Thinking row", (await row(1).count()) === 0);
    await page.waitForTimeout(900); // the conversation eases to the bottom
    const followed = await page.evaluate(() => {
      const scroller = document.querySelector(".conversation-inner").parentElement;
      const actions = [...document.querySelectorAll(".answer-actions")].at(-1).getBoundingClientRect();
      const composer = document.querySelector(".bottom-composer").getBoundingClientRect();
      return {
        fromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
        scrolls: scroller.scrollHeight > scroller.clientHeight * 1.5,
        endInView: actions.bottom <= composer.top + 1,
      };
    });
    check("  after a Thinking row was opened, the next answer still streams into view",
      followed.scrolls && followed.fromBottom < 80 && followed.endInView, JSON.stringify(followed));

    await ask("Find a fern for shade");
    const source = { title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade.", read: true };
    await send(
      { type: "start", messageId: "research-1", messageMetadata: { demo: false } },
      { type: "reasoning-start", id: "thinking-1" },
      { type: "reasoning-delta", id: "thinking-1", delta: Array.from({ length: 30 }, (_, i) => `Step ${i + 1}: this needs the web.`).join("\n") },
      { type: "message-metadata", messageMetadata: { thinkingMs: 1200 } },
      { type: "reasoning-end", id: "thinking-1" },
      { type: "data-research", id: "research", data: { phase: "writing", queries: ["ferns"], sources: [source], demo: false, engine: "kernel", steps: ["Selected Kernel"] } },
      { type: "source-url", sourceId: "1", url: source.url, title: source.title },
      { type: "reasoning-start", id: "thinking-2" },
      { type: "reasoning-delta", id: "thinking-2", delta: "Source 1 answers it." },
      { type: "message-metadata", messageMetadata: { thinkingMs: 3600 } },
      { type: "reasoning-end", id: "thinking-2" },
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: "Most ferns like shade [1](https://ferns.example/care)." },
      { type: "text-end", id: "answer" },
      { type: "data-research", id: "research", data: { phase: "complete", queries: ["ferns"], sources: [source], demo: false, engine: "kernel", steps: ["Selected Kernel"] } },
      { type: "finish", finishReason: "stop" },
    );
    await end();
    await page.waitForFunction(() => document.querySelectorAll(".answer-actions").length === 3, null, { timeout: 10000 });
    const order = await page.locator(".assistant-message").nth(2).evaluate((el) => {
      const rows = el.querySelectorAll(".thinking");
      const panel = el.querySelector(".agent-activity");
      return {
        rows: rows.length,
        above: !!(rows[0] && panel && rows[0].compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING),
        label: rows[0]?.innerText,
      };
    });
    check("thinking before a research call is one row above the research panel",
      order.rows === 1 && order.above && /^Thought for 4 s/.test(order.label), JSON.stringify(order));
    await toggle(2).click();
    await page.waitForTimeout(600); // the conversation eases any scroll
    const inPlace = await toggle(2).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: innerHeight };
    });
    check("  a long thought opens in place, its row still in view",
      inPlace.top >= 0 && inPlace.bottom <= inPlace.height, JSON.stringify(inPlace));

    await ask("Stop halfway?");
    await send(
      { type: "start", messageId: "cut-1", messageMetadata: { demo: false } },
      { type: "reasoning-start", id: "thinking-1" },
      { type: "reasoning-delta", id: "thinking-1", delta: "Half a thought" },
    );
    await row(3).waitFor({ timeout: 5000 });
    // An open box follows a thought as it streams, until the reader scrolls up in it.
    await toggle(3).click();
    const lines = (from) => Array.from({ length: 40 }, (_, i) => `\nLine ${from + i}: still thinking it through.`).join("");
    await send({ type: "reasoning-delta", id: "thinking-1", delta: lines(1) });
    await page.waitForTimeout(300);
    const box = row(3).locator(".thinking-text");
    const position = () => box.evaluate((el) => ({
      fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      top: Math.round(el.scrollTop),
      tall: el.scrollHeight > el.clientHeight * 2,
    }));
    const live = await position();
    check("  an open Thinking box shows the newest line while the thought streams",
      live.tall && live.fromBottom < 24, JSON.stringify(live));
    await box.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(100);
    await send({ type: "reasoning-delta", id: "thinking-1", delta: lines(41) });
    await page.waitForTimeout(300);
    const readBack = await position();
    check("  and stays put once the reader scrolls up in it", readBack.top === 0, JSON.stringify(readBack));
    await end();
    await page.waitForFunction(() => !document.querySelector(".thinking-shimmer"), null, { timeout: 5000 }).catch(() => {});
    const cut = await toggle(3).innerText();
    check("an answer that ends mid-thought says Thinking stopped", /^Thinking stopped/.test(cut), cut);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
    await page.locator(".mobile-menu").click();
    await page.locator('[data-mobile="true"] .history-item', { hasText: "hey" }).click();
    await page.waitForSelector(".thinking", { timeout: 5000 }).catch(() => {});
    check("a saved conversation keeps its collapsed Thinking row",
      /^Thought for 2 s/.test(await toggle(0).innerText().catch(() => "")) && (await row(1).count()) === 0);
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // Many sources: every one gets a card in a row that swipes sideways.
    const { context, page, errors } = await open(PHONE);
    const sources = Array.from({ length: 6 }, (_, i) => ({
      title: `Source page number ${i + 1} with a longer title`,
      url: `https://site${i + 1}.example.com/article`,
      content: `Text of page ${i + 1}.`,
      read: true,
      ...(i < 2 ? { image: pixel } : {}),
    }));
    await page.route("**/api/chat", (route) => route.fulfill(stream([
      { type: "start", messageId: "stub-1" },
      { type: "data-research", id: "research", data: { phase: "complete", queries: ["q"], sources, demo: false, engine: "kernel", steps: ["Selected Kernel", "Kernel read 6 source pages"] } },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "An answer drawn from six pages. [1](https://site1.example.com/article)" },
      { type: "text-end", id: "a" },
      { type: "data-suggestions", data: ["Tell me more"] },
      { type: "finish", finishReason: "stop" },
    ])));
    await page.getByRole("textbox").fill("Which pages cover this?");
    await page.getByRole("textbox").press("Enter");
    await finished(page);
    const row = await page.evaluate(() => {
      const el = document.querySelector(".source-cards");
      return { cards: el?.querySelectorAll(".source-card").length, images: el?.querySelectorAll("img").length,
        swipes: el && el.scrollWidth > el.clientWidth, sideScroll: document.documentElement.scrollWidth > innerWidth };
    });
    check("an answer with 6 sources shows all 6 cards, pictures where pages have them",
      row.cards === 6 && row.images === 2, JSON.stringify(row));
    check("  in one row that swipes sideways, without scrolling the page sideways", row.swipes && !row.sideScroll, JSON.stringify(row));
    await shot(page, "many-sources-phone");
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // Photos: pick through the + menu, preview, limit, shrink, show, and keep only thumbnails.
    const { context, page, errors } = await open(PHONE);
    const bodies = [];
    page.on("request", (r) => r.url().endsWith("/api/chat") && bodies.push(JSON.parse(r.postData())));
    await addPhotos(page, [photoFile("big.png", 3000, 2000, [200, 40, 40]), photoFile("small.png", 800, 600, [40, 40, 200])]);
    await page.waitForFunction(() => document.querySelectorAll(".composer-photo").length === 2, null, { timeout: 5000 }).catch(() => {});
    check("photos chosen from the + menu show as previews in the question box", (await page.locator(".composer-photo").count()) === 2);
    await page.locator(".composer-photo").nth(1).getByRole("button", { name: "Remove photo" }).click();
    check("  a preview can be removed", (await page.locator(".composer-photo").count()) === 1);
    await addPhotos(page, Array.from({ length: 4 }, (_, i) => photoFile(`p${i}.png`, 400, 300, [40, 160, 40])));
    await page.waitForTimeout(300);
    const limitToast = await page.getByText("Add up to 4 photos per question.").isVisible().catch(() => false);
    check("  at most 4 photos, with a message when there are more", (await page.locator(".composer-photo").count()) === 4 && limitToast);
    await shot(page, "photos-attached");
    await page.getByRole("textbox").fill("What colour are these?");
    await page.getByRole("textbox").press("Enter");
    await finished(page);
    const sent = bodies[0]?.messages.at(-1).parts.filter((p) => p.type === "file") || [];
    const first = sent[0] ? await imageSize(page, sent[0].url) : null;
    check("sent photos are shrunk JPEGs, the largest side at most 1280 px",
      sent.length === 4 && sent.every((p) => p.mediaType === "image/jpeg" && p.url.startsWith("data:image/jpeg;base64,")) &&
        first?.width === 1280 && first?.height === 853, JSON.stringify({ count: sent.length, first }));
    check("  the question shows its photos", (await page.locator(".user-message .user-photos img").count()) === 4);
    check("  the question box is empty again", (await page.locator(".composer-photo").count()) === 0);
    check("  sample mode says it can't look at photos", /can.t look at photos/.test(await page.locator(".answer-body").innerText()));
    await shot(page, "photos-sent");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("scout-threads-v1") || "[]")[0]?.messages[0]?.parts.filter((p) => p.type === "file").map((p) => p.url) || []);
    const thumb = stored[0] ? await imageSize(page, stored[0]) : null;
    check("  history keeps only small thumbnails", stored.length === 4 && stored.every((u) => u.length < 40000) && thumb?.width === 200,
      JSON.stringify({ count: stored.length, thumb, longest: Math.max(0, ...stored.map((u) => u.length)) }));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // A photo with no words: asks what is in it and skips web search.
    const { context, page } = await open(PHONE);
    const bodies = [];
    page.on("request", (r) => r.url().endsWith("/api/chat") && bodies.push(JSON.parse(r.postData())));
    await addPhotos(page, [photoFile("only.png", 640, 480, [90, 90, 20])]);
    await page.waitForSelector(".composer-photo");
    await page.getByRole("button", { name: "Send question" }).click();
    await finished(page);
    const last = bodies[0]?.messages.at(-1);
    check("a photo sent with no words asks what's in it, without web search",
      last?.parts.some((p) => p.type === "text" && p.text === "What's in this photo?") && bodies[0]?.webEnabled === false,
      JSON.stringify({ webEnabled: bodies[0]?.webEnabled, parts: last?.parts.map((p) => p.type) }));
    await context.close();
  }
  {
    const response = await fetch(new URL("/api/chat", BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preview: true, messages: [{ role: "user", parts: [
        { type: "file", mediaType: "image/gif", url: "data:image/gif;base64,R0lGODlh" },
        { type: "text", text: "What is this?" },
      ] }] }),
    });
    check("the server turns away a GIF with a clear message",
      response.status === 400 && /JPEG, PNG, or WebP/.test(await response.text()), String(response.status));
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
    await webChip(page).click();
    await chip(page, "photo source card").click();
    await finished(page);
    const answer = await page.locator(".answer-body").innerText();
    check("web-off request says webEnabled: false", bodies[0]?.webEnabled === false);
    check("web-off sample answer has no leftover citation text", !/\.jpg\)|\]\(|\[\d\]/.test(answer), JSON.stringify(answer.slice(0, 160)));
    await context.close();
  }
  {
    const { context, page } = await open(PHONE);
    await chip(page, "photo source card").click();
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
    await chip(page, "AI agents search the web").click();
    await page.waitForSelector(".error-banner", { timeout: 20000 });
    check("a failed request shows its error", /research service is busy/.test(await page.locator(".error-banner").innerText()));
    await page.getByRole("button", { name: "Try again" }).click();
    await page.waitForSelector(".followup", { timeout: 20000 });
    check("Try again answers without repeating the question", (await page.locator(".user-message").count()) === 1,
      `${await page.locator(".user-message").count()} copies of the question`);
    await context.close();
  }
  {
    const { context, page } = await open();
    await chip(page, "AI agents search the web").click();
    await finished(page);
    await page.getByRole("button", { name: /New conversation/ }).click();
    await page.waitForSelector(".suggestion-chip");
    await page.locator(".scout-sidebar .history-item", { hasText: "AI agents search the web" }).click();
    const reopened = await page.waitForSelector(".answer-body", { timeout: 5000 }).then(() => true, () => false);
    check("a saved conversation reopens from the sidebar", reopened && (await page.locator(".user-message").count()) === 1);
    await context.close();
  }
  {
    // Switching away from a streaming sample answer at once, and straight back.
    const { context, page, errors } = await open();
    await chip(page, "AI agents search the web").click();
    await finished(page);
    await page.getByRole("button", { name: /New conversation/ }).click();
    await chip(page, "Compare React and Next.js").click();
    await conversationItem(page, "Compare React").waitFor({ timeout: 5000 });
    const leftRunning = await answering(page, "Compare React").isVisible();
    await conversationItem(page, "AI agents search the web").click();
    await conversationItem(page, "Compare React").click();
    await finished(page);
    const text = await page.locator(".conversation").innerText();
    const counts = { questions: await page.locator(".user-message").count(), answers: await page.locator(".assistant-message").count() };
    check("a sample answer left at once and opened again is there in full, exactly once",
      leftRunning && counts.questions === 1 && counts.answers === 1 && /prepared comparison/.test(text) && !/Research stopped/.test(text),
      JSON.stringify({ leftRunning, counts, text: text.slice(0, 200) }));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("scout-threads-v1") || "[]")
      .find((t) => /Compare React/.test(t.title))?.messages.map((m) => m.role));
    check("  and saved once", JSON.stringify(saved) === '["user","assistant"]', JSON.stringify(saved));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // Answers keep running in conversations that are not on screen, and show a spinner there.
    const { context, page, errors } = await openHeld();
    const running = () => page.locator('.scout-sidebar .history-item [aria-label="Still answering"]').count();
    await askHeld(page, "First question");
    check("while an answer runs, its conversation shows a spinner labelled Still answering",
      await answering(page, "First question").isVisible());
    await page.getByRole("button", { name: /New conversation/ }).click();
    await page.waitForSelector(".suggestion-chip");
    check("  New conversation leaves that answer running", await answering(page, "First question").isVisible());
    await askHeld(page, "Second question");
    check("  answers in two conversations run at the same time", (await running()) === 2, `${await running()} spinners`);
    await shot(page, "answering-sidebar");
    await conversationItem(page, "First question").click();
    await page.locator(".user-message", { hasText: "First question" }).waitFor();
    const waiting = await page.locator(".progress-strip").innerText({ timeout: 5000 }).catch(() => "");
    check("  going back shows the answer still thinking, not stopped", /Thinking…/.test(waiting), waiting);
    await conversationItem(page, "Second question").click();
    await page.locator(".user-message", { hasText: "Second question" }).waitFor();
    await sendHeld(page, "First question", [
      { type: "data-research", id: "research", data: { phase: "searching", queries: ["q"], sources: [], demo: false, engine: "kernel", steps: ["Selected Kernel"] } },
      ...writeText("First answer, "),
    ]);
    await conversationItem(page, "First question").click();
    await page.locator(".answer-body", { hasText: "First answer," }).waitFor({ timeout: 5000 });
    const midway = await page.locator(".assistant-message").innerText();
    check("  and, mid-answer, its research and words so far", !/Research stopped/.test(midway) &&
      (await page.locator(".agent-activity").count()) === 1 && (await page.getByRole("button", { name: "Stop research" }).isVisible()), midway);

    await page.getByRole("button", { name: "Close sidebar" }).click();
    await page.waitForTimeout(450);
    const railRunning = page.locator(".sidebar-rail").getByRole("button", { name: /^Still answering: / });
    check("the folded rail shows a spinner button for each running answer", (await railRunning.count()) === 2,
      JSON.stringify(await railRunning.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))));
    await shot(page, "answering-rail");
    await page.getByRole("button", { name: "Still answering: Second question" }).click();
    const opened = await page.locator(".user-message", { hasText: "Second question" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    check("  a rail spinner button opens its conversation", opened);
    await sendHeld(page, "First question", [
      { type: "text-delta", id: "a", delta: "written while you were away." },
      { type: "data-research", id: "research", data: { phase: "complete", queries: ["q"], sources: [], demo: false, engine: "kernel", steps: ["Selected Kernel"] } },
      ...finishText,
    ], true);
    const leftRail = await page.getByRole("button", { name: "Still answering: First question" })
      .waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
    check("  an answer that finishes leaves the rail", leftRail && (await railRunning.count()) === 1);
    await sendHeld(page, "Second question", [...writeText("Second answer."), ...finishText], true);
    await page.waitForSelector(".answer-actions", { timeout: 5000 });
    check("  the answer on screen finishes there", (await page.locator(".assistant-message").count()) === 1 &&
      /Second answer\./.test(await page.locator(".answer-body").innerText()) && (await railRunning.count()) === 0);

    await page.getByRole("button", { name: "Open sidebar" }).click();
    await page.waitForTimeout(450);
    check("the spinners go once the answers are done", (await running()) === 0, `${await running()} spinners`);
    await conversationItem(page, "First question").click();
    await page.locator(".user-message", { hasText: "First question" }).waitFor();
    await page.waitForSelector(".answer-actions", { timeout: 5000 });
    const answers = await page.locator(".assistant-message").allInnerTexts();
    check("the answer that finished off screen is there once, complete",
      answers.length === 1 && /First answer, written while you were away\./.test(answers[0]) &&
        !/Research stopped/.test(answers[0]) && (await page.locator(".user-message").count()) === 1,
      JSON.stringify(answers));
    const stopped = await page.evaluate(() => Object.values(window.__answers).filter((a) => a.aborted).length);
    check("  switching never stopped an answer", stopped === 0, `${stopped} stopped`);
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // A reload ends a running answer; the words written so far stay.
    const { context, page, errors } = await openHeld();
    const question = "What happens on a reload?";
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      window.__writes = {};
      Storage.prototype.setItem = function (key, value) {
        window.__writes[key] = (window.__writes[key] || 0) + 1;
        return setItem.call(this, key, value);
      };
    });
    await askHeld(page, question);
    await sendHeld(page, question, writeText("The first half of an answer"));
    await page.locator(".answer-body", { hasText: "The first half of an answer" }).waitFor({ timeout: 5000 });
    await page.evaluate(() => (window.__writes = {}));
    for (let i = 1; i <= 4; i++) {
      await page.waitForTimeout(600);
      await sendHeld(page, question, [{ type: "text-delta", id: "a", delta: `, part ${i}` }]);
    }
    const writes = await page.evaluate(() => window.__writes);
    check("an answer that streams is saved on its own each second, without rewriting the whole history",
      !writes["scout-threads-v1"] && writes["scout-drafts-v1"] >= 2, JSON.stringify(writes));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
    await conversationItem(page, question).click();
    const kept = await page.locator(".answer-body", { hasText: "The first half of an answer, part 1, part 2, part 3, part 4" })
      .waitFor({ timeout: 5000 }).then(() => true, () => false);
    check("a reload mid-answer keeps the words written so far", kept && (await page.locator(".assistant-message").count()) === 1,
      await page.locator(".conversation").innerText());
    const storage = await page.evaluate(() => ({
      history: localStorage.getItem("scout-threads-v1") || "", drafts: localStorage.getItem("scout-drafts-v1"),
    }));
    check("  and moves them into the saved history", storage.history.includes("part 4") && storage.drafts === null, JSON.stringify(storage.drafts));
    check("  and shows no spinner, since the reload ended it", (await page.locator('.scout-sidebar [aria-label="Still answering"]').count()) === 0);
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // Stop ends only the answer on screen. Deleting a conversation stops its answer, and it does not come back.
    const { context, page, errors } = await openHeld();
    await askHeld(page, "Keep this one running");
    await page.getByRole("button", { name: /New conversation/ }).click();
    await askHeld(page, "Stop this one");
    await page.getByRole("button", { name: "Stop research" }).click();
    const stoppedHere = await page.waitForFunction(() => window.__answers["Stop this one"].aborted, null, { timeout: 5000 }).then(() => true, () => false);
    check("Stop ends the answer on screen, and only that one",
      stoppedHere && !(await answering(page, "Stop this one").isVisible()) &&
        (await answering(page, "Keep this one running").isVisible()) &&
        !(await page.evaluate(() => window.__answers["Keep this one running"].aborted)));
    const question = "Delete this one";
    await page.getByRole("button", { name: /New conversation/ }).click();
    await askHeld(page, question);
    await page.keyboard.press("Control+k");
    await page.getByRole("button", { name: `Delete ${question}` }).click();
    await page.keyboard.press("Escape");
    const aborted = await page.waitForFunction((q) => window.__answers[q].aborted, question, { timeout: 5000 }).then(() => true, () => false);
    await page.waitForTimeout(1500);
    const stored = await page.evaluate(() => (localStorage.getItem("scout-threads-v1") || "") + (localStorage.getItem("scout-drafts-v1") || ""));
    check("deleting a conversation with a running answer stops the answer",
      aborted && (await conversationItem(page, question).count()) === 0 && !stored.includes(question),
      JSON.stringify({ aborted, stored: stored.slice(0, 120) }));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // Many answers at once on a short window, and Try again in an older conversation.
    const { context, page, errors } = await openHeld({ viewport: { width: 1280, height: 600 } });
    const listed = page.locator(".nav-section .history-item");
    const older = "A long research question";
    await askHeld(page, older);
    const others = Array.from({ length: 8 }, (_, i) => `Another question ${i + 1}`);
    for (const question of others) {
      await page.getByRole("button", { name: /New conversation/ }).click();
      await askHeld(page, question);
    }
    check("a running answer below the first 8 conversations still shows in the list, with its spinner",
      (await listed.count()) === 9 && (await answering(page, older).isVisible()), JSON.stringify(await listed.allInnerTexts()));

    await page.getByRole("button", { name: "Close sidebar" }).click();
    await page.waitForTimeout(450);
    const rail = page.locator(".sidebar-rail");
    const railRunning = rail.getByRole("button", { name: /^Still answering: / });
    const settings = await rail.getByRole("button", { name: "Workspace settings" }).boundingBox();
    await railRunning.last().scrollIntoViewIfNeeded();
    const lastRunning = await railRunning.last().boundingBox();
    check("on a short window, the folded rail keeps Workspace settings on screen and scrolls its running answers",
      (await railRunning.count()) === 9 && settings && settings.y + settings.height <= 600 &&
        lastRunning && lastRunning.y >= 0 && lastRunning.y + lastRunning.height <= settings.y,
      JSON.stringify({ count: await railRunning.count(), settings, lastRunning }));
    await shot(page, "answering-rail-short");
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await page.waitForTimeout(450);

    for (const question of others) await sendHeld(page, question, [...writeText("Done."), ...finishText], true);
    await sendHeld(page, older, [{ type: "error", errorText: "The research engine stopped responding." }], true);
    await answering(page, older).waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    const belowTheList = (await listed.count()) === 8 && (await conversationItem(page, older).count()) === 0;
    await page.keyboard.press("Control+k");
    await page.locator(".history-dialog-item button", { hasText: older }).click();
    await page.evaluate((q) => (window.__answers[q].old = true), older);
    await page.getByRole("button", { name: "Try again" }).click();
    await page.waitForFunction((q) => !window.__answers[q].old, older);
    await page.getByRole("button", { name: /New conversation/ }).click();
    await page.waitForSelector(".suggestion-chip");
    const top = listed.first();
    check("Try again in an older conversation moves it to the top of the list, with a spinner while it runs",
      belowTheList && (await top.innerText()).includes(older) &&
        (await top.getByRole("img", { name: "Still answering" }).isVisible()),
      JSON.stringify({ belowTheList, listed: await listed.allInnerTexts() }));
    await sendHeld(page, older, [...writeText("Found it."), ...finishText], true);
    const done = await top.getByRole("img", { name: "Still answering" })
      .waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
    check("  and it stays there once the answer is done", done && (await top.innerText()).includes(older));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // When the browser cannot save, one message says so, not one every few seconds.
    const { context, page, errors } = await openHeld();
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      window.__storageFull = true;
      Storage.prototype.setItem = function (key, value) {
        if (window.__storageFull && key.startsWith("scout-")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return setItem.call(this, key, value);
      };
      window.__saveToasts = 0;
      let shown = false;
      setInterval(() => {
        const now = [...document.querySelectorAll("[data-sonner-toast]")]
          .some((el) => el.dataset.removed !== "true" && /could not save/.test(el.textContent));
        if (now && !shown) window.__saveToasts++;
        shown = now;
      }, 50);
    });
    const question = "A long answer on a full device";
    const more = (text) => sendHeld(page, question, [{ type: "text-delta", id: "a", delta: text }]);
    await askHeld(page, question);
    await sendHeld(page, question, writeText("Words"));
    // Research runs a while with nothing new to save, and the message closes on its own.
    await page.waitForTimeout(6000);
    for (let i = 0; i < 4; i++) {
      await more(` ${i}`);
      await page.waitForTimeout(450);
    }
    const whileFull = await page.evaluate(() => window.__saveToasts);
    check("when the browser cannot save, it says so once while an answer streams", whileFull === 1, `${whileFull} messages`);
    await page.evaluate(() => (window.__storageFull = false));
    await sendHeld(page, question, finishText, true);
    await page.waitForSelector(".answer-actions", { timeout: 5000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => (window.__storageFull = true));
    await askHeld(page, "And a follow-up on a full device");
    await page.waitForTimeout(500);
    const again = await page.evaluate(() => window.__saveToasts);
    check("  and again when saving fails after it has worked", again === 2, `${again} messages`);
    await sendHeld(page, "And a follow-up on a full device", [...writeText("Done."), ...finishText], true);
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    // Forgetting the access code stops every running answer, and keeps what each has written.
    let locked = false;
    const { context, page, errors } = await openHeld({
      config: () => ({ ...LIVE_CONFIG, ...(locked ? { access: "required", modelConnected: false, searchConnected: false } : { access: "granted" }) }),
    });
    await askHeld(page, "First answer to stop");
    await sendHeld(page, "First answer to stop", writeText("Half of the first answer"));
    await page.getByRole("button", { name: /New conversation/ }).click();
    await askHeld(page, "Second answer to stop");
    locked = true;
    await page.locator(".workspace-button").click();
    await page.getByRole("button", { name: "Forget" }).click();
    const gated = await page.getByRole("heading", { name: "Enter your access code" })
      .waitFor({ timeout: 5000 }).then(() => true, () => false);
    const stopped = await page.waitForFunction(() => Object.values(window.__answers).every((a) => a.aborted), null, { timeout: 5000 })
      .then(() => true, () => false);
    const stored = await page.evaluate(() => localStorage.getItem("scout-threads-v1") || "");
    check("Forget access code stops every running answer and keeps the words written so far",
      gated && stopped && stored.includes("Half of the first answer") && stored.includes("Second answer to stop"),
      JSON.stringify({ gated, stopped, stored: stored.slice(0, 160) }));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    const { context, page } = await open(PHONE);
    await chip(page, "AI agents search the web").click();
    await finished(page);
    await page.getByRole("button", { name: "New conversation" }).click();
    const fresh = await page.waitForSelector(".suggestion-chip", { timeout: 5000 }).then(() => true, () => false);
    check("on phones the top bar starts a new conversation", fresh && (await page.locator(".user-message").count()) === 0);
    await context.close();
  }
  {
    // WebMCP: fake document.modelContext and call the registered tool.
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.__tools = [];
      document.modelContext = { registerTool: (tool) => { window.__tools.push(tool); } };
    });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__tools.some((t) => t.name === "research_question"));
    const result = await page.evaluate(() =>
      window.__tools.findLast((t) => t.name === "research_question").execute({ question: "How do AI agents search the web?" }),
    );
    check("WebMCP research_question returns the finished answer and its sources",
      /prepared example/.test(result.answer) && result.sources.length === 3 && result.demo === true,
      JSON.stringify(result).slice(0, 200));
    await context.close();
  }
  {
    // With an engine connected, Sample mode starts off and the engine choice appears.
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.route("**/api/config", (route) => route.fulfill({ json: {
      demo: false, modelConnected: true, searchConnected: true, modelName: "Test model",
      engines: { browserUse: true, kernel: true, tavily: false, jev: false },
    } }));
    const bodies = [];
    await page.route("**/api/chat", (route) => {
      bodies.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: 503, body: "stubbed" });
    });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
    await (await menuItem(page, "menuitemradio", "Kernel")).click();
    for (const question of ["What changed in the latest release?", "And the one before?"]) {
      await page.getByRole("textbox").fill(question);
      await page.getByRole("textbox").press("Enter");
      await page.waitForSelector(".error-banner", { timeout: 10000 });
    }
    check("with an engine connected, typed questions stay live and keep the chosen engine",
      bodies.length === 2 && bodies.every((b) => b.preview === false && b.engine === "kernel" && b.webEnabled === true),
      JSON.stringify(bodies.map(({ preview, engine, webEnabled }) => ({ preview, engine, webEnabled }))));
    const sample = await menuItem(page, "menuitemcheckbox", "Sample answers");
    check("  Sample answers is still off afterwards", (await sample.getAttribute("aria-checked")) === "false");
    await context.close();
  }
  {
    // With Kernel and a vision model connected, the vision agent is a research engine.
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.route("**/api/config", (route) => route.fulfill({ json: {
      access: "open", demo: false, modelConnected: true, searchConnected: true, modelName: "Atria Dawn Preview",
      engines: { browserUse: true, kernel: true, visionAgent: true, tavily: false, jev: true, vision: true },
    } }));
    const bodies = [];
    await page.route("**/api/chat", (route) => {
      bodies.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: 503, body: "stubbed" });
    });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
    await (await menuItem(page, "menuitemradio", "Vision agent")).click();
    await page.getByRole("textbox").fill("Which fern suits a shady balcony?");
    await page.getByRole("textbox").press("Enter");
    await page.waitForSelector(".error-banner", { timeout: 10000 });
    check("the vision agent can be chosen in the + menu and is sent as the engine", bodies[0]?.engine === "vision_agent",
      JSON.stringify(bodies[0]?.engine));
    await context.close();
  }
  {
    // Turning web search off must survive sending a typed question.
    const { context, page } = await open();
    const bodies = [];
    page.on("request", (r) => r.url().endsWith("/api/chat") && bodies.push(JSON.parse(r.postData())));
    await webChip(page).click();
    await page.getByRole("textbox").fill("How do AI agents search the web?");
    await page.getByRole("textbox").press("Enter");
    await finished(page);
    await page.getByRole("textbox").fill("How can I check if a source is reliable?");
    await page.getByRole("textbox").press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".answer-actions").length === 2, null, { timeout: 20000 }).catch(() => {});
    await finished(page);
    check("typed questions keep web search off once it is turned off",
      bodies.length === 2 && bodies.every((b) => b.webEnabled === false),
      JSON.stringify(bodies.map((b) => b.webEnabled)));
    check("  the Web chip is still off afterwards", (await webChip(page).getAttribute("aria-pressed")) === "false");
    await context.close();
  }
  {
    // Desktop: the sidebar folds to an icon rail, like ChatGPT, and this device remembers it.
    const { context, page, errors } = await open();
    const measure = () => page.evaluate(() => ({
      sidebar: document.querySelector(".scout-sidebar")?.getBoundingClientRect().width,
      main: document.querySelector(".main-shell")?.getBoundingClientRect().width,
      sideScroll: document.documentElement.scrollWidth > innerWidth,
      saved: localStorage.getItem("scout.sidebar"),
      early: document.documentElement.getAttribute("data-scout-sidebar"),
    }));
    // The width eases over about 0.2 s.
    const settle = () => page.waitForTimeout(450);
    const listShown = () => page.getByText("YOUR CONVERSATIONS").isVisible();
    const railButton = (name) => page.getByRole("button", { name, exact: true });
    await chip(page, "AI agents search the web").click();
    await finished(page);
    const wide = await measure();
    await shot(page, "sidebar-expanded");
    check("the desktop sidebar starts open, 252 px wide, with the conversation list",
      Math.abs(wide.sidebar - 252) <= 2 && (await listShown()), JSON.stringify(wide));

    const motion = await page.locator(".scout-sidebar").evaluate((el) => getComputedStyle(el).transition);
    await page.getByRole("button", { name: "Close sidebar" }).click();
    await settle();
    const rail = await measure();
    check("Close sidebar folds it to a slim rail without the conversation list",
      rail.sidebar <= 72 && !(await listShown()), JSON.stringify(rail));
    check("  the main area widens, and nothing scrolls sideways",
      rail.main >= wide.main + 150 && !rail.sideScroll, JSON.stringify({ wide, rail }));
    check("  the width slides over about 0.2 s", /width 0\.2\d*s/.test(motion), motion);
    // A click leaves focus alone, so no Open sidebar label pops up away from the pointer.
    const clickTip = await page.locator('[data-slot="tooltip-content"]', { hasText: "Open sidebar" }).count();
    check("  a click on Close sidebar shows no label on the rail", clickTip === 0, `${clickTip} open`);
    const railBox = await page.locator(".sidebar-rail").boundingBox();
    const offsets = [];
    for (const name of ["Open sidebar", "New conversation", "Search chats", "Explore a research example", "Workspace settings"]) {
      const box = await railButton(name).boundingBox().catch(() => null);
      offsets.push(box && railBox ? Math.round(Math.abs(box.x + box.width / 2 - (railBox.x + railBox.width / 2))) : name);
    }
    check("  the rail shows centered icon buttons to open, start, search, explore and settings",
      offsets.every((offset) => offset === 0 || offset === 1), JSON.stringify(offsets));
    const background = () => railButton("Search chats").evaluate((el) => getComputedStyle(el).backgroundColor);
    const resting = await background();
    await railButton("Search chats").hover();
    const tip = await page.locator('[data-slot="tooltip-content"]', { hasText: "Search chats" })
      .waitFor({ timeout: 3000 }).then(() => true, () => false);
    await page.waitForTimeout(250);
    const hovered = await background();
    check("  each shows its name on hover, with a hover highlight", tip && hovered !== resting, `${resting} → ${hovered}`);
    await page.mouse.move(700, 400, { steps: 5 });
    await page.waitForTimeout(250);
    await shot(page, "sidebar-collapsed");

    await railButton("New conversation").click();
    const fresh = await page.waitForSelector(".suggestion-chip", { timeout: 5000 }).then(() => true, () => false);
    check("the rail's New conversation opens a fresh conversation",
      fresh && (await page.locator(".user-message").count()) === 0);
    await railButton("Search chats").click();
    const search = await page.getByRole("dialog", { name: "Your conversations" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await railButton("Workspace settings").click();
    const settings = await page.getByRole("dialog", { name: "Your Scout workspace" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    check("  its Search chats and Workspace settings buttons open their panels", search && settings, JSON.stringify({ search, settings }));
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
    const reloaded = await measure();
    check("after a reload the sidebar is still a rail",
      reloaded.sidebar <= 72 && reloaded.saved === "collapsed" && reloaded.early === null && !(await listShown()), JSON.stringify(reloaded));

    await railButton("Open sidebar").click();
    await settle();
    const reopened = await measure();
    check("Open sidebar brings back the full 252 px sidebar and remembers it",
      Math.abs(reopened.sidebar - 252) <= 2 && reopened.saved === "expanded" && (await listShown()) && !reopened.sideScroll,
      JSON.stringify(reopened));

    await page.keyboard.press("Control+b");
    await settle();
    const byKey = await measure();
    await page.keyboard.press("Control+b");
    await settle();
    const backByKey = await measure();
    check("Ctrl+B folds the sidebar and opens it again",
      byKey.sidebar <= 72 && byKey.saved === "collapsed" && Math.abs(backByKey.sidebar - 252) <= 2 && backByKey.saved === "expanded",
      JSON.stringify({ byKey, backByKey }));

    // Folding or opening hides the focused button, so focus moves to the button that undoes it.
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName);
    const toggleFrom = async (locator, key) => {
      await locator.focus();
      await page.keyboard.press(key);
      await settle();
      return focused();
    };
    const closeButton = page.getByRole("button", { name: "Close sidebar" });
    const keyed = {
      fold: await toggleFrom(closeButton, "Control+b"),
      open: await toggleFrom(railButton("Search chats"), "Control+b"),
      foldCmd: await toggleFrom(closeButton, "Meta+b"),
      openCmd: await toggleFrom(railButton("Open sidebar"), "Meta+b"),
    };
    check("  with focus in the sidebar, Ctrl+B and Cmd+B move it to the button that undoes the change",
      keyed.fold === "Open sidebar" && keyed.open === "Close sidebar" && keyed.foldCmd === "Open sidebar" && keyed.openCmd === "Close sidebar",
      JSON.stringify(keyed));
    const pressed = { fold: await toggleFrom(closeButton, "Enter"), open: await toggleFrom(railButton("Open sidebar"), "Enter") };
    check("  and so do the Close sidebar and Open sidebar buttons from the keyboard",
      pressed.fold === "Open sidebar" && pressed.open === "Close sidebar", JSON.stringify(pressed));
    await page.getByRole("textbox").fill("Keep this text");
    await page.keyboard.press("Control+b");
    await settle();
    const typing = await page.getByRole("textbox").evaluate((el) => ({ focused: document.activeElement === el, value: el.value }));
    await page.keyboard.press("Control+b");
    await settle();
    check("  Ctrl+B while typing a question keeps the focus and the text",
      typing.focused && typing.value === "Keep this text", JSON.stringify(typing));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    const { context, page } = await open(undefined, { reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Close sidebar" }).click();
    const folded = await page.locator(".scout-sidebar").evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      transition: getComputedStyle(el).transitionProperty,
    }));
    check("with reduce motion on, the sidebar folds at once, without sliding",
      folded.width <= 72 && folded.transition === "none", JSON.stringify(folded));
    await context.close();
  }
  {
    // A saved rail is in place from the first paint, before the app's JavaScript runs.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      localStorage.setItem("scout.sidebar", "collapsed");
      window.__sidebarWidths = [];
      document.addEventListener("DOMContentLoaded", () => {
        const el = document.querySelector(".scout-sidebar");
        if (el) new ResizeObserver(() => window.__sidebarWidths.push(el.getBoundingClientRect().width)).observe(el);
      });
    });
    const page = await context.newPage();
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route(/\/_next\/static\/.+\.js(\?|$)/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const early = await page.evaluate(() => ({
      width: document.querySelector(".scout-sidebar")?.getBoundingClientRect().width,
      list: [...document.querySelectorAll(".sidebar-label")].some((el) => el.checkVisibility()),
    }));
    release();
    await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 10000 }).catch(() => {});
    const loaded = await page.evaluate(() => ({
      width: document.querySelector(".scout-sidebar")?.getBoundingClientRect().width,
      widest: Math.max(0, ...window.__sidebarWidths),
      early: document.documentElement.getAttribute("data-scout-sidebar"),
    }));
    check("a saved rail shows from the first paint, before the app loads", early.width <= 72 && !early.list, JSON.stringify(early));
    check("  and stays a rail while the app loads, without a flash of the open sidebar",
      loaded.width <= 72 && loaded.widest <= 72 && loaded.early === null, JSON.stringify(loaded));
    await context.close();
  }
  {
    // Touch tablets wide enough for the rail get finger-sized buttons to fold and open it.
    const { context, page } = await open({ width: 800, height: 1280 }, { hasTouch: true });
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    const box = (name) => page.getByRole("button", { name, exact: true }).boundingBox();
    const brand = await page.getByRole("button", { name: "Scout home" }).boundingBox();
    const close = await box("Close sidebar");
    await page.getByRole("button", { name: "Close sidebar" }).tap();
    await page.waitForTimeout(450);
    const reopen = await box("Open sidebar");
    const finger = (b) => b && b.width >= 42 && b.width <= 48 && b.height >= 42 && b.height <= 48;
    check("on touch tablets, Close sidebar and Open sidebar are 42 to 48 px touch targets",
      coarse && finger(close) && finger(reopen), JSON.stringify({ coarse, close, reopen }));
    check("  Close sidebar stays in line with the brand, inside the sidebar",
      Math.abs(close.y + close.height / 2 - (brand.y + brand.height / 2)) <= 2 && close.x + close.width <= 252 - 16,
      JSON.stringify({ brand, close }));
    await context.close();
  }
  {
    // Phones keep the drawer, even when this device left the desktop sidebar folded.
    const saved = { cookies: [], origins: [{ origin: new URL(BASE).origin, localStorage: [{ name: "scout.sidebar", value: "collapsed" }] }] };
    const { context, page, errors } = await open({ width: 390, height: 844 }, { storageState: saved });
    const railsShown = () => page.locator(".sidebar-rail:visible, .scout-sidebar:visible").count();
    check("on phones no rail shows", (await railsShown()) === 0);
    const menu = page.locator(".mobile-menu");
    const menuBox = await menu.boundingBox();
    await menu.click();
    const drawer = page.locator('[data-mobile="true"]');
    const opened = await drawer.waitFor({ timeout: 5000 }).then(() => true, () => false);
    await page.waitForTimeout(600); // the drawer slides in
    await shot(page, "sidebar-phone");
    check("  the menu button opens the full drawer, with a 42 px touch target",
      opened && (await drawer.getByText("YOUR CONVERSATIONS").isVisible()) && (await railsShown()) === 0 &&
        menuBox?.width >= 42 && menuBox?.height >= 42,
      JSON.stringify(menuBox));
    check("  the drawer has no desktop Close sidebar button", (await page.getByRole("button", { name: "Close sidebar" }).count()) === 0);
    await drawer.getByRole("button", { name: /New conversation/ }).click();
    check("  an action in the drawer closes it", await drawer.waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false));
    check("  nothing scrolls sideways", !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
    check("no console or page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  for (const [width, height] of [[1280, 720], [1366, 640], [1280, 800], [412, 915], [360, 640]]) {
    const { context, page } = await open({ width, height });
    await shot(page, `home-${width}x${height}`);
    const layout = await page.evaluate(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const bar = box(".topbar"), heading = box("h1"), composer = box(".composer");
      return {
        headingVisible: heading.top >= bar.bottom - 1 && heading.bottom <= composer.top + 1,
        composerVisible: composer.bottom <= innerHeight + 1,
        sideScroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    check(`${width}x${height}: heading and question box fully visible, no side scroll`,
      layout.headingVisible && layout.composerVisible && !layout.sideScroll, JSON.stringify(layout));
    await context.close();
  }
  // Research jobs, against a server in test mode with durable research (a fake answer model and a
  // fake Browser Use Cloud): SCOUT_TEST_MODE=1 WORKFLOW_TARGET_WORLD=local npx next start
  const server = await (await fetch(new URL("/api/config", BASE))).json().catch(() => ({}));
  if (!server.durable || !server.test) {
    console.log("SKIP  research job checks: the server is not in test mode with durable research");
  } else {
    const counters = async () => (await (await fetch(new URL("/api/config", BASE))).json()).test;
    // The page sees a connected workspace; its questions reach the test-mode server's fake model.
    const openLive = async (viewport) => {
      const context = await browser.newContext({ viewport });
      await context.route("**/api/config", (route) => route.fulfill({
        json: { ...LIVE_CONFIG, durable: true, engines: { ...LIVE_CONFIG.engines, browserUse: true } },
      }));
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
      return { context, page, errors };
    };
    const ask = async (page, text) => {
      await page.getByRole("textbox").fill(text);
      await page.getByRole("textbox").press("Enter");
    };
    const answerText = (page) => page.locator(".assistant-message").allInnerTexts();
    const done = (page, ms = 60000) => page.waitForFunction(
      () => [...document.querySelectorAll(".assistant-message")].some((m) => /The test research found 2 sources/.test(m.innerText)),
      null, { timeout: ms },
    ).then(() => true, () => false);
    // The job's Answer has started to stream its words (the test answer takes about eight seconds).
    const streamingAnswer = (page) => page.waitForFunction(
      () => /The test research found/.test([...document.querySelectorAll(".assistant-message .answer-body")].at(-1)?.textContent || ""),
      null, { timeout: 60000 },
    ).then(() => true, () => false);
    // The Answer is finished: its job is over, so Stop is gone.
    const over = (page) => page.waitForFunction(
      () => document.querySelector(".answer-actions") &&
        ![...document.querySelectorAll("button")].some((b) => /Stop/.test(b.getAttribute("aria-label") || "")),
      null, { timeout: 60000 },
    ).then(() => true, () => false);
    const stillStreaming = (page) => page.getByRole("button", { name: /Stop/ }).count().then((n) => n > 0);
    const onlyOnce = (texts) => texts.length === 1 && (texts[0].match(/The test research found 2 sources/g) || []).length === 1;
    // Switching away from the app and back, as a desktop tab or Android does.
    const setShown = (page, state) => page.evaluate((state) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
      if (state === "visible") document.dispatchEvent(new Event("resume"));
    }, state);
    // Reads of a job from the start of its stream: a full replay.
    const replays = (page) => {
      const seen = [];
      page.on("request", (r) => /\/api\/jobs\/[^/]+\/stream\?startIndex=0$/.test(r.url()) && seen.push(r.url()));
      return seen;
    };
    const watched = (page) => page.evaluate(() => window.__watch);
    {
      // Research that starts after the old in-request budget, then the app is closed and opened again.
      const { context, page, errors } = await openLive(PHONE);
      await context.route("**/api/chat", (route) => route.continue({
        headers: { ...route.request().headers(), "x-scout-test-started-ago": "250000" },
      }));
      const jobs = (await counters()).jobsStarted;
      await ask(page, "hi");
      await page.waitForFunction(() => /Scout's test model/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
      check("research job: \"hi\" gets a direct answer and starts no job",
        /Scout's test model/.test((await answerText(page)).join(" ")) && (await counters()).jobsStarted === jobs);
      await page.locator(".topbar-new").click();
      await ask(page, "Please research ferns for a shady balcony");
      await page.waitForSelector(".agent-activity", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      check("  research starts a job, 250 s after the request began", (await counters()).jobsStarted === jobs + 1);
      await page.close();
      // The fake research takes 20 s; the app is away for most of it.
      await new Promise((resolve) => setTimeout(resolve, 12000));
      const again = await context.newPage();
      again.on("pageerror", (e) => errors.push(e.message));
      await again.goto(BASE, { waitUntil: "networkidle" });
      await again.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
      await again.locator(".mobile-menu").click();
      await again.locator('[data-mobile="true"] .history-item', { hasText: "Please research ferns" }).click();
      const finishedAway = await done(again);
      const texts = await answerText(again);
      check("  closing the app mid-research: the answer is there when it opens again, exactly once",
        finishedAway && texts.length === 1 && (texts[0].match(/The test research found 2 sources/g) || []).length === 1,
        JSON.stringify(texts).slice(0, 300));
      // The job's last chunks (research complete, then finish) can come in the next response window.
      check("  its research panel says Research complete with the job's sources",
        await again.waitForFunction(() => /Research complete/.test(document.querySelector(".agent-activity")?.textContent || ""),
          null, { timeout: 15000 }).then(() => true, () => false),
        await again.locator(".agent-activity").innerText().catch(() => ""));
      check("  the job is over: no Stop button, the answer's actions show",
        await again.waitForFunction(() => document.querySelectorAll(".answer-actions").length === 1 &&
          ![...document.querySelectorAll("button")].some((b) => /Stop/.test(b.getAttribute("aria-label") || b.textContent || "")),
        null, { timeout: 15000 }).then(() => true, () => false));
      check("  no console or page errors", errors.length === 0, errors.join(" | "));
      await context.close();
    }
    {
      // Offline mid-research (the phone loses its connection), then back.
      const { context, page, errors } = await openLive(PHONE);
      await ask(page, "Please research shade ferns while offline");
      await page.waitForSelector(".agent-activity", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await context.setOffline(true);
      await page.waitForTimeout(8000);
      await context.setOffline(false);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      const back = await done(page);
      const texts = await answerText(page);
      check("research job: offline mid-research, the answer completes once the connection is back",
        back && texts.length === 1 && (texts[0].match(/The test research found 2 sources/g) || []).length === 1,
        JSON.stringify(texts).slice(0, 300));
      check("  no error banner is left", (await page.locator(".error-banner").count()) === 0,
        await page.locator(".error-banner").allInnerTexts().then((t) => t.join(" | ")));
      check("  no page errors", errors.length === 0, errors.join(" | "));
      await context.close();
    }
    {
      // Switching away and back while the job researches and while its Answer streams: nothing restarts.
      const { context, page, errors } = await openLive(PHONE);
      const replayed = replays(page);
      await ask(page, "Please research ferns while I switch apps");
      await page.waitForSelector(".agent-steps li", { timeout: 15000 }).catch(() => {});
      await page.evaluate(watchAnswer);
      await setShown(page, "hidden");
      await page.waitForTimeout(2500);
      await setShown(page, "visible");
      const streamed = await streamingAnswer(page);
      await page.waitForTimeout(500);
      await setShown(page, "hidden");
      await page.waitForTimeout(1000);
      await setShown(page, "visible");
      await page.waitForTimeout(300);
      await setShown(page, "hidden");
      await setShown(page, "visible");
      const finishedHere = await over(page);
      const seen = await watched(page);
      check("research job: switching away and back never restarts the answer: its words never get fewer",
        streamed && finishedHere && seen.longest > 400 && seen.dom.shrank.length === 0, JSON.stringify(seen));
      check("  its research steps and source cards are never replaced by older ones",
        seen.dom.steps.length === 0 && seen.dom.sources.length === 0, JSON.stringify(seen));
      check("  no Reconnecting note while it streams, and no replay from the start",
        seen.reconnecting === 0 && replayed.length === 0, JSON.stringify({ reconnecting: seen.reconnecting, replayed }));
      check("  it completes once", onlyOnce(await answerText(page)));
      check("  no page errors", errors.length === 0, errors.join(" | "));
      await context.close();
    }
    {
      // The connection drops for a few seconds while the Answer streams: it carries on from where it was.
      const { context, page, errors } = await openLive(PHONE);
      const replayed = replays(page);
      await ask(page, "Please research ferns while the phone loses signal");
      const streamed = await streamingAnswer(page);
      await page.evaluate(watchAnswer);
      await context.setOffline(true);
      await page.waitForTimeout(6000);
      const whileOffline = (await watched(page)).longest;
      await context.setOffline(false);
      const finishedHere = await over(page);
      const seen = await watched(page);
      check("research job: offline mid-answer, the answer carries on from where it was, without a replay",
        streamed && finishedHere && seen.dom.shrank.length === 0 && replayed.length === 0 && seen.longest > whileOffline,
        JSON.stringify({ seen, replayed, whileOffline }));
      check("  it completes once, with no error banner",
        onlyOnce(await answerText(page)) && (await page.locator(".error-banner").count()) === 0,
        JSON.stringify(await answerText(page)).slice(0, 300));
      check("  no page errors", errors.length === 0, errors.join(" | "));
      await context.close();
    }
    {
      // A reader who scrolled up stays where they are while the Answer streams, also after switching away and back.
      const { context, page, errors } = await openLive({ width: 412, height: 640 });
      await ask(page, "Please research ferns for a long read");
      const streamed = await streamingAnswer(page);
      const log = page.locator(".conversation-inner").locator("xpath=..");
      const canScroll = await page.waitForFunction(() => {
        const el = document.querySelector(".conversation-inner")?.parentElement;
        return el && el.scrollHeight > el.clientHeight + 400;
      }, null, { timeout: 15000 }).then(() => true, () => false);
      await page.mouse.move(206, 320);
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(500);
      const scrollTop = () => log.evaluate((el) => el.scrollTop);
      const before = await scrollTop();
      await setShown(page, "hidden");
      await page.waitForTimeout(500);
      await setShown(page, "visible");
      await page.waitForTimeout(1500);
      const after = await scrollTop();
      const streamingStill = await stillStreaming(page);
      const growing = await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      check("research job: scrolled up while the answer streams, the reader stays put when the app comes back",
        streamed && canScroll && streamingStill && Math.abs(after - before) <= 4 && growing > 100,
        JSON.stringify({ before, after, streamingStill, growing }));
      await over(page);
      check("  no page errors", errors.length === 0, errors.join(" | "));
      await context.close();
    }
    {
      // A reload mid-answer (a cold start) still reads the job again from its start, and ends once.
      const { context, page, errors } = await openLive({ width: 1280, height: 520 });
      await context.addInitScript(watchAnswer);
      await ask(page, "Please research ferns and then reload");
      await streamingAnswer(page);
      await page.waitForTimeout(2500);
      const replayed = replays(page);
      // The replay answers a little late, so the reader can scroll up before it lands.
      await context.route(/\/stream\?startIndex=0$/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue().catch(() => {});
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector(".logo-reveal", { state: "detached", timeout: 5000 }).catch(() => {});
      await conversationItem(page, "Please research ferns and then reload").click();
      await page.waitForSelector(".assistant-message .answer-body", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(900);
      await page.mouse.move(760, 220);
      await page.mouse.wheel(0, -160);
      await page.waitForTimeout(400);
      const log = page.locator(".conversation-inner").locator("xpath=..");
      const scrollTop = () => log.evaluate((el) => el.scrollTop);
      const before = await scrollTop();
      await page.waitForTimeout(3500);
      const after = await scrollTop();
      const finishedHere = await over(page);
      const seen = await watched(page);
      check("research job: a reload mid-answer reads the job again and completes exactly once",
        finishedHere && replayed.length >= 1 && onlyOnce(await answerText(page)),
        JSON.stringify({ replayed, texts: (await answerText(page)).map((t) => t.slice(0, 80)) }));
      check("  the replay never shows less than the saved answer on screen",
        seen.painted.shrank.length === 0 && seen.painted.steps.length === 0 && seen.painted.sources.length === 0, JSON.stringify(seen));
      check("  a reader who scrolled up stays where they are when the replay lands",
        before > 0 && Math.abs(after - before) <= 4, JSON.stringify({ before, after }));
      check("  no page errors", errors.length === 0, errors.join(" | "));
      await context.close();
    }
    {
      // Stop ends the job on the server, including its Browser Use run.
      const { context, page, errors } = await openLive(PHONE);
      const before = await counters();
      await ask(page, "Please research ferns and then stop");
      await page.waitForSelector(".agent-activity", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      await page.getByRole("button", { name: /Stop/ }).click();
      await page.waitForTimeout(4000);
      const after = await counters();
      check("research job: Stop cancels the job's Browser Use run on the server",
        after.browserRunsCancelled === before.browserRunsCancelled + 1, JSON.stringify({ before, after }));
      await page.waitForTimeout(20000);
      check("  a stopped job never writes its answer later",
        !/The test research found/.test((await answerText(page)).join(" ")));
      check("  the question box is ready again", (await page.getByRole("button", { name: /Stop/ }).count()) === 0);
      check("  no page errors", errors.length === 0, errors.join(" | "));
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll browser checks passed");
process.exit(failures ? 1 : 0);
