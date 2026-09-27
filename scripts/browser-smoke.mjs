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
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll browser checks passed");
process.exit(failures ? 1 : 0);
