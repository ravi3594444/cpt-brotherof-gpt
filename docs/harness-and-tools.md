# Scout harness and tool schemas

Scout is a server-orchestrated research assistant with a mobile-first React
chat. The chat UI uses Vercel AI SDK and AI Elements. `app/api/chat/route.ts`
checks each request; the answer loop lives in `lib/answer.ts`, the research
flow in `lib/web-research.ts`, and browser adapters in
`lib/cloud-research.ts`. The model provider is an OpenAI-compatible Chat
Completions endpoint; the present private preview uses Atria Dawn Preview.
Keys are server-side environment variables.

## Run sequence

1. `POST /api/chat` validates the most recent user turn, conversation size,
   engine choice, same-origin request, and available credentials. It starts a
   UI message stream, with research status events when research runs.
2. Sample mode returns prepared answers. Chat-only mode (Search the web off)
   streams directly from the connected model, with no tools, without claiming
   web verification.
3. With Search the web on, the answer model decides whether to research. It
   gets one tool, `web_research({ task })`, with `toolChoice: "auto"`. The task
   is 1 to 2000 characters: a self-contained research task in the user's
   language, with any links the user gave. The model calls it when the user
   asks it to research, search, find, look up, compare or check something, or
   when a good answer needs current or verifiable facts; otherwise it answers
   directly and the stream has no research parts. Scout adds no rules of its
   own to that decision. Research runs once per message, with one retry at
   most. If it fails (or finds no sources), the model gets
   `{ error, canRetry, secondsLeft, retry }`: why it failed, the seconds left
   before the 280-second ceiling, and whether it may call the tool once more.
   It may only when at least 90 seconds remain and the failure would not
   simply repeat: a rejected key, no credit, a rate limit (HTTP 401, 402,
   403, 429), or a Browser Use run whose creation got no answer and may
   still be running are not retried. The retry must end 220 seconds into the
   request, leaving the answer 60. Otherwise, and after any
   successful research or a second call, the next step cannot call the tool
   (`toolChoice: "none"`) and the loop stops after it (at most three steps),
   so a third call never runs; a call while research is running, or after it
   succeeded, gets an error result. That step still defines the tool,
   because some providers reject a tool call and result sent without one.
   The system prompt forbids promising later work ("let me try again", "I
   will search") unless the model calls the tool in the same reply; when
   research failed for good, the model says in one sentence what happened,
   gives what it knows with a clear caveat that it is not from sources, and
   suggests how to narrow the question. The research record keeps both
   tries' steps in order, the successful try's sources, and the warning, and
   marks a failed research the model was told about (`failed: true`), which
   the panel shows as "Research incomplete", also while the model decides
   whether to try again or writes the answer. Each failed try adds the step
   "Research did not finish: <reason>", shown without a check mark. The
   answer model should
   support OpenAI-style tool calling. When the first call is rejected with
   HTTP 400, 404, or 422 about tools or functions (a context-length error
   does not count), Scout asks the same model in plain text for one word,
   RESEARCH or ANSWER, from the last six messages. A leading `<think>` block
   is skipped; an unclear reply or a failed call means research. It then
   researches the question and answers from the evidence, or answers
   directly.
4. When research runs, the server chooses one engine. An explicit selection
   wins. Auto uses JEV to choose between Kernel and Browser Use Cloud when
   both and a JEV key (AI/ML API or TypeSafe) are available; low confidence or a JEV failure
   chooses Browser Use Cloud. With just one browser key, that engine runs.
   Auto leaves out an engine that needs more time than research has left
   (Browser Use Cloud 60 seconds, the vision agent 45, Kernel 20), which
   matters for a late retry; each engine also refuses to open a paid browser
   with less than its minimum, including when chosen explicitly.
   The older Tavily adapter remains available as a compatibility fallback.
5. Browser Use Cloud runs its own browser agent. Kernel creates an entirely
   separate cloud browser and executes a fixed Playwright snippet for public
   search/page reading. The code never sends model-generated JavaScript to
   Kernel.
6. The server validates public source URLs, keeps up to six Browser Use
   sources or four Kernel pages, and returns the observed evidence to the
   answer model, numbered in order, as the tool result (in the plain-text
   fallback, in its instructions). When the engine gave a warning, such as a
   partial result, the result is `{ warning, sources }` so the model knows;
   a page reached with no text recorded is marked so the model does not
   cite it for facts. The model must cite exact supplied links;
   source content is untrusted. The UI stream includes action steps, citations, and
   source cards with images when a page provides one.
7. The route has a 280-second ceiling (`maxDuration` is 300). Research has a
   budget: it must end 200 seconds after the request starts, so the answer
   has the rest. `streamAnswer` passes that deadline to `webResearch` and on
   to every engine, which also aborts any request still waiting 5 seconds
   after it. Browser Use Cloud polls the run's status every 2 seconds until
   8 seconds before the deadline (shopping sites often need 1 to 3 minutes),
   each poll ending by then, and reads the full run once it completes.
   Creating the run may take up to 30 seconds; with no answer by then, the
   run may exist, so Scout does not start another. If time runs out, the run
   fails, or status polls fail three times in a row, Scout reads the run's
   events (up to five pages, following the cursor) and keeps up to six
   public pages the agent reached, with their titles and the text it
   extracted or noted there, as sources that are not read, with the warning
   "The browser agent ran out of time; these are the pages it had reached"
   (or "stopped early"). Search pages, Browser Use's own links, and signed
   file links are left out. Only when nothing usable was reached does
   research fail. Then Scout cancels a run it stopped polling and stops the
   run's cloud browser (found in the `browser.ready` event, or by listing
   the session's active browsers), in the background with 5-second
   timeouts, after every run: a finished run does not stop its browser. That
   cleanup, and closing Kernel sessions, is registered with `after()` from
   `next/server`, which the route passes to `webResearch` (the platform's
   `waitUntil` on Vercel and Cloudflare), so it still finishes when the user
   stops the answer or the ceiling cuts it off.
   Browser Use runs have a one-dollar maximum cost per request. Kernel fits
   its script's `timeout_sec` into the time left and does not open a browser
   with less than 20 seconds; its sessions are deleted after use even on
   failure. The vision agent stops at its own budget or the deadline,
   whichever comes first, keeps the pages it read, and does not open a
   browser with less than 45 seconds. Requests stop on
   client cancellation.

Research steps are an **observable workflow**, not the model's reasoning.
Displayed steps are actions the server actually took, such as selecting a
browser, opening a session, visiting pages, and collecting sources.

The answer model's own reasoning is shown apart from them, as **Thinking**:
the provider's `reasoning_content` (or `reasoning`), or `<think>` or
`<thinking>` blocks (in any case) that open a step's text, streams as UI
reasoning parts, one per thought, before and after a research call, in the
plain-text fallback, and with Search the web off. A think tag later in an
answer stays in the answer, and an empty thought shows nothing. Message
metadata `thinkingMs` carries the finished thoughts' total time. The UI folds
Thinking into one row ("Thinking…", then "Thought for N s") that opens to plain
text and, while a thought streams, shows its newest line. It is never sent back
to the model. Saved history keeps up to 20,000 characters of it per answer, and
when the device runs out of room, older conversations give theirs up first.
Because reasoning tokens count against the output limit on most providers, the
answer allows 16,000 output tokens (4,096 for a model that turns that away) and
the Search API query plan 1,500, with leading think blocks stripped before its
JSON is read.

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
seconds, or until the research deadline if that is sooner. Each step Scout sends the vision model the page's address, a numbered
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
first and the answer model gets that description as text (for text-only
models such as Atria Dawn Preview); web research uses the words of the tool's
task only. A photo with no typed
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
  steps?: string[];     // observable action log of every try, not hidden reasoning
  warning?: string;     // a partial result, or why research failed
  failed?: boolean;     // research failed and the answer model was told why
  demo: boolean;
};
// Stream parts: data-research, source-url, reasoning-start/delta/end,
// message-metadata ({ thinkingMs }), text-start/delta/end, finish.
// data-research and source-url appear only when the answer model researched.
```

Images are optional. Product research, scientific diagrams, articles, and
other topics all use the same source schema. Browser Use is instructed to
return actual product image URLs if found. Kernel reads a visited page's
`og:image`. The UI links each card to its source page and does not generate
fake product pictures.

## Cloud tool contracts

| Tool | Request | Response used by Scout | Key |
| --- | --- | --- | --- |
| Browser Use Cloud V4 | `POST https://api.browser-use.com/api/v4/runs` with `task`, `maxCostUsd: 1`, and an output schema for `sources[{url,title,summary,image?}]`; poll `GET /api/v4/runs/{id}/status`, then `GET /api/v4/runs/{id}` once; when it ends without a result, `GET /api/v4/runs/{id}/events?after=` (cursor `nextAfter`, while `hasMore`); cancel `POST /api/v4/runs/{id}/cancel`; stop the browser with `PATCH /api/v4/browsers/{id}` `{"action":"stop"}` (id from `browser.ready`'s `data.browser_session_id`, or `GET /api/v4/browsers?agentSessionId=`) | completed run's structured `output.sources` or parseable `result`; otherwise the pages its events reached | `BROWSER_USE_API_KEY` in `X-Browser-Use-API-Key` |
| Kernel browser | `POST https://api.onkernel.com/browsers`; `POST /browsers/{id}/playwright/execute` with fixed `code` and `timeout_sec`; `DELETE /browsers/{id}` | Playwright's returned list `[{url,title,content,read,image?}]` | `KERNEL_API_KEY` as Bearer |
| JEV | `POST https://api.aimlapi.com/v1/decisions` with `model: "typesafe/jev"` (AI/ML API), or `POST https://api.typesafe.ai/v1/systemone` with `model: "jev-latest"` (TypeSafe); both take `state` and a `choice` question between `kernel` and `browser_use` | `answers.route.choice` and `confidence`; Kernel requires confidence at least 0.65 | `AIMLAPI_API_KEY` or `TYPESAFE_API_KEY` as Bearer |
| Answer model | OpenAI-compatible Chat Completions via Vercel AI SDK `streamText`, with OpenAI-style tool calling for `web_research` (plain-text RESEARCH/ANSWER fallback otherwise) | the research decision, then answer tokens grounded in validated source list | `MODEL_BASE_URL`, `MODEL_ID`, `MODEL_API_KEY` |
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
