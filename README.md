# Scout

A mobile-first research chat built with React, Vercel AI SDK and AI Elements.
The chat shows source links, optional page images, and a visible log of
research actions. Its connected answer model uses an OpenAI-compatible API.

## Try it

The [owner-private Sites preview](https://scout-web-research.belugaremodeling.chatgpt.site)
shows sample answers, citations, research steps, and the source panel. Sample
mode is clearly marked and never claims to browse. Turn Sample off to use the
connected model for ordinary chat. Live browser research becomes available
after adding at least one browser service key to the server.

The interface supports new chats, follow-ups, device-local history, a
sideways row with a card for every source (with the page's picture when it
has one), citations, copy-with-sources, stop generation, and up to four photos
per question for the answer model. A short logo intro plays when the app
opens (skipped with a tap, or when the device asks for reduced motion). The
layout is phone-first, like ChatGPT's home screen, for the Android app. On
wider screens the sidebar folds to an icon rail (or press Ctrl+B / ⌘B), and
the device remembers the choice; phones keep the menu drawer.

## Server configuration

Put these values in the host's secret environment, not in the app bundle:

| Variable | Purpose |
| --- | --- |
| `MODEL_BASE_URL` | HTTPS base for OpenAI-compatible Chat Completions |
| `MODEL_ID` | Model name supported at that endpoint |
| `MODEL_API_KEY` | Model provider key |
| `MODEL_DISPLAY_NAME` | Friendly name shown in the workspace |
| `BROWSER_USE_API_KEY` | Browser Use Cloud V4 agent and its own cloud browser |
| `KERNEL_API_KEY` | Kernel cloud browser sessions and Playwright execution |
| `AIMLAPI_API_KEY` | Optional JEV routing between the two browser services, through AI/ML API (`typesafe/jev`) |
| `TYPESAFE_API_KEY` | The same JEV routing straight from TypeSafe (used only when `AIMLAPI_API_KEY` is not set) |
| `TAVILY_API_KEY` | Optional legacy search/extraction fallback |
| `VISION_MODEL_ID` | Optional model that can see, e.g. `deepseek/deepseek-v4.1-flash` on AI/ML API. It describes photos for a text-only answer model (such as Atria Dawn Preview), drives the Vision agent's browser, and writes the answer after research |
| `VISION_MODEL_BASE_URL` | OpenAI-compatible address of the vision model; defaults to `https://api.aimlapi.com/v1` |
| `VISION_MODEL_API_KEY` | Key for the vision model; defaults to `AIMLAPI_API_KEY` |
| `RESEARCH_WRITER` | Optional. `answer` keeps the answer model as the writer of answers after research; by default the vision model writes them, since it is much faster |
| `SCOUT_ACCESS_CODE` | Optional. When set, the app and API ask for this code, so strangers who find the site cannot spend your credit |
| `RESEARCH_MAX_COST_USD` | Optional money cap for one research's Browser Use run, in US dollars (default 2). A Research job has no time limit, so this cap and Stop are what end a run that never finishes |
| `SCOUT_DURABLE_RESEARCH` | Optional. `off` keeps research inside the chat request, with its 200-second budget, even on Vercel |

For live research, connect the model plus Browser Use **or** Kernel. With
the Web chip on, the answer model gets a `web_research` tool and decides for
itself when to use it: when you ask it to research, find, look up, compare or
check something, or when a good answer needs current facts. A greeting,
writing, math or code gets a direct reply with no research and no citations.
The tool takes the task, a short search query the engines start with (never
the whole task sentence), and a depth: quick, the default, when a few pages
are enough, or deep when you ask for thorough, comprehensive or detailed
research, or for many sources or sites. Anything the model writes before it
calls the tool ("I'll research…") moves into the Thinking row, so the answer
holds only what it wrote after research.
The answer model should support OpenAI-style tool calling. If the provider
rejects tools, Scout asks the model in plain text whether to research (one
word, RESEARCH or ANSWER) and then researches or answers directly.

On Vercel, research runs as a **Research job** (Vercel Workflows, included in
the free Hobby plan). A reply that needs no research, such as "hi", stays in
the chat request and is as fast as before. When the answer model calls
`web_research`, the rest of the turn moves into a job: the research, split
into steps of a few minutes each, then the answer, written in a step of its
own. A job has no time limit. Browser Use can browse for as long as the task
needs (up to its own 4-hour session), and the Vision agent can take up to 10
steps for quick research and 40 for deep. Only `RESEARCH_MAX_COST_USD`, Stop, and a guard against runs that never
end (60 Browser Use windows, about 4 hours) stop it early. The job keeps going
when the app is closed, the phone locks or the connection drops; the app reads
the answer again when it comes back, and it survives a reload. Vercel keeps a
finished job for one day on Hobby, so an answer left unopened longer than that
is gone and Scout says so. A typical job uses about 20 to 40 of Hobby's 50,000
workflow events a month. Research jobs need Vercel (or `next dev` and
`next start`, which run them locally); on Cloudflare, research stays in the
request as described next.

Without Research jobs, research has a time budget: it ends 200 seconds into the request, so the
answer has time before the 280-second ceiling. Browser Use Cloud gets that
whole budget, since shopping sites often need one to three minutes. If it
runs out of time or stops early, Scout keeps up to six pages the agent had
reached as sources (not read, with a warning the model also gets) instead
of failing, and it stops the Browser Use cloud browser after every run so it
does not idle, even when the answer is stopped. No engine opens a paid
browser without enough time left to use it.
Research that fails quickly can be retried once, when at least 90 seconds
remain and the failure would not simply repeat (a rejected key, no credit, a
rate limit); the model is told why research failed and whether it may
retry, and never promises a search it is not making. With
Kernel and a vision model connected, the **Vision agent** engine lets the vision
model drive a real Kernel browser (open, click, type into search boxes, scroll,
read) for up to 8 steps (16 for deep research). It stops by itself once it has
read 3 pages (6 for deep); a reply with no action is asked once more, shorter,
and if the model still says nothing it ends with the pages it read. JEV can
choose it in Auto. Kernel's own script reads its pages side by side, so four
pages take about as long as the slowest one.

For Atria Dawn Preview, use `MODEL_BASE_URL=https://api.atria-asi.ai/v1`
and `MODEL_ID=Atria-Dawn-Preview`; Atria reads text only, so set a vision model
for photos. With a vision model set, the vision model also writes the answer
after research, from the same sources and with the same rules, because a
reasoning model like Atria can think for minutes over them first; Atria still
answers directly and decides when to research. Set `RESEARCH_WRITER=answer` to
keep Atria as the writer. If the vision model fails before its first word,
Atria writes the answer. Atria is a reasoning model: it thinks before its first word. Scout
shows that thinking as a collapsed "Thinking…" row above the answer, and lets
each answer use up to 16,000 output tokens, since thinking counts against the
limit on most providers (Atria accepts up to 65,536). A model whose output cap
is lower, which turns 16,000 away, gets the answer with 4,096. For a self-hosted
reasoning model whose chat template opens the `<think>` block itself (DeepSeek
R1 or QwQ on vLLM or SGLang), start the server with its reasoning parser so the
thinking arrives as `reasoning_content`; otherwise it shows in the answer. The two
browser keys together enable engine choice in the chat. In Auto, Kernel does
most research: plain Kernel, the fastest, for questions a few pages answer
(facts, explanations, how things work, news, reviews, comparisons), the Vision
agent for using a site like a person (searching inside it, filters, product
listings and prices, pictures, charts), and Browser Use Cloud only when JEV is
at least 65% sure a task needs its heavier agent. When JEV is unavailable, or
without a JEV key, Auto uses Kernel, then the Vision agent, then Browser Use
Cloud for quick research, and the Vision agent first for deep research; an
unsure Kernel choice stays Kernel for quick research and becomes the Vision
agent for deep. When JEV fails, the research steps say why ("JEV was
unavailable (HTTP 402); using Kernel", or timed out, network error, unexpected
answer), and the server log has the status and the start of the response. A
second research for the same answer, after the first failed, tries an engine
not used yet, with Browser Use Cloud as the backup. JEV is optional and only selects the path in
Auto mode. It does not browse, answer, or run locally
on Android. The current private preview already has its answer model
configured; its browser services still need keys. Never commit real keys or
put them in `NEXT_PUBLIC_` variables.

See [harness and tool schemas](docs/harness-and-tools.md) for the run sequence,
request and response types, provider API shapes, cancellation behavior,
cost ceiling, and Android integration boundary.

## Deploy on Vercel

`vercel.json` builds Scout as a standard Next.js app: it installs with pnpm
11.25.0 (the version `pnpm-workspace.yaml` needs) and runs `next build`.

Its functions run in Singapore (`sin1`), next to the Atria API (Alibaba Cloud
`ap-southeast-1`), so every answer starts sooner. Kernel and Browser Use run
in the US, so research steps take a little longer from there. If you use a
different answer model, set `regions` to the Vercel region closest to it.

1. In Vercel, import this GitHub repository. Keep the defaults; `vercel.json`
   sets the install and build commands.
2. In **Project → Settings → Environment Variables**, add the variables from
   the table above (at least `MODEL_BASE_URL`, `MODEL_ID`, `MODEL_API_KEY`, and
   `BROWSER_USE_API_KEY` or `KERNEL_API_KEY`). They stay on the server; the
   browser and the Android app never see them.
3. Add `SCOUT_ACCESS_CODE` with a long code of your choice. Scout then asks
   for it once on each phone or browser and refuses requests without it.
4. Redeploy so the new variables take effect.

Vercel limits request bodies to 4.5 MB, so the chat route refuses requests
over 4.4 MB (photos are shrunk on the device and fit well inside). The chat
route may run for up to 300 seconds (`maxDuration`), the most Hobby allows;
Research jobs are not bound by it. Without `SCOUT_ACCESS_CODE`, anyone who finds the
Vercel address can use Scout with your keys' credit.

## Development

Requires Node 22.13+ and pnpm:

```sh
pnpm install
pnpm dev
pnpm exec tsc --noEmit
pnpm lint
pnpm test          # unit tests for the answer loop, research, engine choice, links, and samples
pnpm build
```

With `pnpm dev` running, `pnpm test:browser` drives sample mode in Chromium:
the logo intro, the home screen, answers, citations, small talk without a
research trail, a direct live answer, a live answer's Thinking row, stubbed
research that ends "Research incomplete" (once, and after a retry) and one
with partial results, a six-source card row,
photos (attach, limit, shrink, thumbnails), history, Try again, the + menu and
Web chip, a stubbed connected workspace, and the layout at desktop and phone
sizes. It needs no
keys and uses Playwright from the project or a global install.

`CONTEXT.md` is the glossary of Scout's domain terms.

The AI Elements code in `components/ai-elements` comes from the official
Vercel AI Elements project under Apache-2.0. The hosting build uses Cloudflare
Workers; `scripts/install-pnpm.sh` and `scripts/build-site.mjs` support the
managed Sites environment.

## Android

`android/` is a Capacitor wrapper with app ID `app.scout.research`. It opens
the hosted Scout site over HTTPS and needs internet access; API keys stay on
that site's server, never in the app. Point it at your deployment and build a
debug APK with JDK 21 and the Android SDK (platform 36):

```sh
SCOUT_APP_URL=https://your-project.vercel.app pnpm exec cap sync android
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

Without `SCOUT_APP_URL` the app opens the original private Sites preview. A
debug APK has been built this way but not yet tested on a device. Store
releases need a release build signed with your own key.

The native on-phone browser/model track is specified in the harness document.
The wrapper does **not** control Chrome or contain local model weights.
Finishing native autonomy requires choosing a supported Android model/runtime,
implementing the WebView action executor, testing it on the target phone, and
adding device authentication for a distributable build. The Sites preview
does not simulate those native permissions.

## Tests and current limits

Mocked adapter tests verify Browser Use run parsing (including prose around
JSON), polling to the research deadline on a fake clock, partial results
from run events, cancelled runs and stopped browsers, Kernel and vision
agent time limits, research depth and search queries, Kernel's parallel page
reading (run against a fake browser), the vision agent's page targets and
empty replies, the research writer and its fallback, narration moved into
Thinking, the minimum time before a paid browser opens, the
one-retry research policy and failures that are not retried,
image/source validation,
Kernel session cleanup, engine choice and the
logged JEV outcome, pasted-link extraction, conversation preparation, and
legacy search error behavior. A
TypeScript check and production build cover the UI and API. The provider
paths cannot be tested end-to-end without the separate Browser Use, Kernel,
and optional JEV (AI/ML API or TypeSafe) keys. Browser Use Cloud runs are capped at `RESEARCH_MAX_COST_USD` (two US dollars
by default) per run; page summaries should always be checked against the links.
