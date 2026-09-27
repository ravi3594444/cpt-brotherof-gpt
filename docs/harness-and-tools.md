# Scout harness and tool schemas

Scout is a server-orchestrated research assistant with a mobile-first React
chat. The chat UI uses Vercel AI SDK and AI Elements. The orchestration code
lives in `app/api/chat/route.ts`, with browser adapters in
`lib/cloud-research.ts`. The model provider is an OpenAI-compatible Chat
Completions endpoint; the present private preview uses Atria Dawn Preview.
Keys are server-side environment variables.

## Run sequence

1. `POST /api/chat` validates the most recent user turn, conversation size,
   engine choice, same-origin request, and available credentials. It starts a
   UI message stream and sends research status events.
2. Sample mode returns prepared answers. Chat-only mode streams directly from
   the connected model without claiming web verification.
3. For live research, the server chooses one engine. An explicit selection
   wins. Auto uses JEV to choose between Kernel and Browser Use Cloud when
   both and a JEV key (AI/ML API or TypeSafe) are available; low confidence or a JEV failure
   chooses Browser Use Cloud. With just one browser key, that engine runs.
   The older Tavily adapter remains available as a compatibility fallback.
4. Browser Use Cloud runs its own browser agent. Kernel creates an entirely
   separate cloud browser and executes a fixed Playwright snippet for public
   search/page reading. The code never sends model-generated JavaScript to
   Kernel.
5. The server validates public source URLs, keeps up to six Browser Use
   sources or four Kernel pages, and passes the observed evidence to the
   connected answer model. The model must cite exact supplied links; source
   content is untrusted. The UI stream includes action steps, citations, and
   source cards with images when a page provides one.
6. The route has a two-minute ceiling. Browser Use runs have a one-dollar
   maximum cost per request and are cancelled if Scout stops polling. Kernel
   sessions are deleted after use even on failure. Requests stop on client
   cancellation.

This is an **observable workflow**, not a stream of private model reasoning.
Displayed steps are actions the server actually took, such as selecting a
browser, opening a session, visiting pages, and collecting sources.

## Public app API

When the server has `SCOUT_ACCESS_CODE`, both endpoints need the code in the
`x-scout-access` request header: `POST /api/chat` answers 401 without it, and
`GET /api/config` returns `access: "required"` with nothing connected. Without
the variable, `access` is `"open"`; with the right code it is `"granted"`.

`GET /api/config` returns only booleans and a display name:

```ts
type ScoutConfig = {
  access: "open" | "granted" | "required";
  demo: boolean;
  modelConnected: boolean;
  searchConnected: boolean;
  modelName: string;
  engines: {
    browserUse: boolean;
    kernel: boolean;
    tavily: boolean;
    jev: boolean;
  };
};
```

`POST /api/chat` accepts:

```ts
type ChatRequest = {
  messages: Array<{
    role: "user" | "assistant";
    parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; mediaType: "image/jpeg" | "image/png" | "image/webp"; url: string } // base64 data URL
    >;
  }>;
  webEnabled: boolean;
  preview?: boolean;
  engine?: "auto" | "browser_use" | "kernel" | "vision_agent" | "tavily";
};
```

Vision agent: with `KERNEL_API_KEY` and a vision model (`VISION_MODEL_ID`), the
`vision_agent` engine opens a Kernel browser and runs up to 8 steps within 200
seconds. Each step Scout sends the vision model the page's address, a numbered
list of its visible clickable elements and text fields, the start of its text,
and a JPEG screenshot; the model replies with one JSON action (`open`, `click`,
`type`, `scroll`, `back`, `read`, `finish`). Scout checks it (only listed
elements, typing only into text or search boxes, only public addresses) and
runs it with fixed Playwright code. Pages it `read`s become sources with
`read: true` for the answer model. The route's ceiling is 280 seconds and
`maxDuration` is 300, Vercel's default limit.

Photos: a question can carry up to four photos. The browser shrinks each to
at most 1280 px (JPEG) before sending and sends photos only for the latest
question that has them, so follow-ups about a photo keep it without resending
older ones. The server accepts only JPEG, PNG, or WebP base64 data URLs and
answers 400 with a plain message otherwise. Photos go to the answer model as
image parts, or, when a vision model is set, the vision model describes them
while research runs and the answer model gets that description as text (for
text-only models such as Atria Dawn Preview); web research uses the typed
words only. A photo with no typed
words is sent as "What's in this photo?" without web search. Sample mode
cannot read photos and says so. If the model fails on a request with photos,
the error says the model may not read images. Saved history keeps a 200 px
thumbnail of each photo.

The response is a Vercel AI SDK UI message stream. Its application events are:

```ts
type ResearchSource = {
  title: string;
  url: string;          // validated public HTTP(S) page
  content: string;      // excerpt, observed page content, or agent summary
  read?: boolean;       // true only for page text actually read
  image?: string;       // optional validated HTTPS page image
};
type ResearchData = {
  phase: "searching" | "reading" | "writing" | "complete";
  queries: string[];
  sources: ResearchSource[];
  engine?: "browser_use" | "kernel" | "vision_agent" | "tavily";
  steps?: string[];     // observable action log, not hidden reasoning
  warning?: string;
  demo: boolean;
};
// Stream parts: data-research, source-url, text-start/delta/end, finish.
```

Images are optional. Product research, scientific diagrams, articles, and
other topics all use the same source schema. Browser Use is instructed to
return actual product image URLs if found. Kernel reads a visited page's
`og:image`. The UI links each card to its source page and does not generate
fake product pictures.

## Cloud tool contracts

| Tool | Request | Response used by Scout | Key |
| --- | --- | --- | --- |
| Browser Use Cloud V4 | `POST https://api.browser-use.com/api/v4/runs` with `task`, `maxCostUsd: 1`, and an output schema for `sources[{url,title,summary,image?}]`; poll `GET /api/v4/runs/{id}`; cancel `POST /api/v4/runs/{id}/cancel` | completed run's structured `output.sources` or parseable `result` | `BROWSER_USE_API_KEY` in `X-Browser-Use-API-Key` |
| Kernel browser | `POST https://api.onkernel.com/browsers`; `POST /browsers/{id}/playwright/execute` with fixed `code` and `timeout_sec`; `DELETE /browsers/{id}` | Playwright's returned list `[{url,title,content,read,image?}]` | `KERNEL_API_KEY` as Bearer |
| JEV | `POST https://api.aimlapi.com/v1/decisions` with `model: "typesafe/jev"` (AI/ML API), or `POST https://api.typesafe.ai/v1/systemone` with `model: "jev-latest"` (TypeSafe); both take `state` and a `choice` question between `kernel` and `browser_use` | `answers.route.choice` and `confidence`; Kernel requires confidence at least 0.65 | `AIMLAPI_API_KEY` or `TYPESAFE_API_KEY` as Bearer |
| Answer model | OpenAI-compatible Chat Completions via Vercel AI SDK `streamText` | answer tokens grounded in validated source list | `MODEL_BASE_URL`, `MODEL_ID`, `MODEL_API_KEY` |
| Legacy search API | Tavily `search` and `extract` | ranked links and snippets, optionally full page text | `TAVILY_API_KEY` |

The Browser Use agent is a hosted browser **and** an agent. Kernel is its own
hosted browser; it is not a Browser Use session. JEV is a remote fast choice
model, not the answer model and not an Android on-device model.

The page also feature-detects the browser's experimental `document.modelContext`
and registers a `research_question` action if available. That action accepts
`{question: string}` of 1–6000 characters and exposes the completed answer
and source list; ordinary users do not need WebMCP.

## On-phone browser track

The checked-in `android/` app is currently a Capacitor wrapper around the
private hosted Scout website. **It does not control Chrome or run an on-device
browser model.** The phone track is a separate native integration:

```ts
type PhoneBrowserAction =
  | { kind: "open"; url: string }
  | { kind: "inspect" }
  | { kind: "tap"; elementId: string }
  | { kind: "type"; elementId: string; text: string }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "back" }
  | { kind: "stop" };
type PhoneBrowserObservation = {
  url: string;
  title: string;
  elements: Array<{ id: string; role: string; label: string }>;
  visibleText: string;
};
```

The intended native harness is an in-app Android WebView plus a local model
adapter that selects one action from the observation. The action executor
should resolve only IDs in the current WebView snapshot and stop before
irreversible actions such as purchases or account changes. It should send
public source URLs and optional image URLs back through the same
`ResearchSource` stream. A system-wide Chrome controller would instead need
an explicitly enabled AccessibilityService and a different permission and
interaction design; this project does not assert that capability.

The model weights, supported phone hardware, Android runtime, and device
testing are still needed to finish that track. JEV cannot fill this role
offline because its published API is remote. No local-model credentials or
Android browser permissions are silently requested by the web frontend.
