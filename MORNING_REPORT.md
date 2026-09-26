# Morning report: Scout overnight check

Your push `a8994d8` ("Build Scout research chat…") arrived at 16:36 UTC. I tested it, fixed what was broken, and added tests. All the work is on the branch **`claude/vigilant-archimedes-2m259a`**. I did not touch `main` and did not open a pull request.

## In short

- **9 bugs found and fixed.** The worst one: in a workspace with research engines connected, **every question you typed was quietly sent in Sample mode**, so it got a sample answer instead of live research.
- **`pnpm lint` failed with 8 errors.** It now passes (0 errors).
- **Tests: 2 test files became 25 unit tests plus 26 real-browser checks.**
- **Not fixed, needs your decision:** `/api/chat` has no login check (details below).

| Check | Before | After |
| --- | --- | --- |
| Typecheck (`tsc`) | pass | pass |
| Lint | **8 errors** | 0 errors, 4 warnings |
| Unit tests | 2 files, pass | 25 tests, pass |
| Production build | pass | pass |
| Browser checks (sample mode, dev and production build) | none existed | 26/26 pass |

## What was broken and what I fixed

The most important fixes come first. For each bug I first wrote a test that failed because of it, then fixed the code.

1. **Typed questions went out in Sample mode, and "Search the web: off" did not stick.** (`cade284`)
   The prompt box resets its form on every send. The Sample and Search-the-web switches sit inside that form, so each send flipped them back to how they started (both on). In a connected workspace this sent every typed question as a sample request. Suggestion buttons were not affected. I detached the switches from the form.
   *Test:* browser checks that send two typed questions, one with a stubbed connected workspace and one with web search off.

2. **Browser Use sources could lose their titles and summaries.** (`bacc960`)
   Browser Use's own docs say v4 may ignore the output schema and return text, and Scout asked for "a short synthesis and a JSON object". Text plus JSON failed to parse, so every source got its domain as the title and the same block of text as its content. Scout now finds the JSON inside the text and asks for JSON only. The agent can also no longer mark its own summary as "Page content read".

3. **Pasted links ending with punctuation opened the wrong page.** (`8f0a598`)
   "Summarize https://example.com/article." sent Kernel and the Search API to `/article.` with the full stop. The same link-finding code existed three times with different rules. It is now one tested function, used by all three places.

4. **The research steps misreported JEV's decision.** (`a04b914`)
   When JEV failed or was unsure, the log still said "JEV selected Browser Use Cloud", which breaks the promise that the steps show what really happened. It now says, for example, "JEV was unavailable; using Browser Use Cloud". Engine choice moved out of the route into a tested function. The Search API path also no longer shows "Reading relevant pages" while it is still searching.

5. **After a failed answer, the next request sent an empty message to the model.** (`e616b61`)
   Stricter OpenAI-compatible providers reject empty messages. Empty turns are now dropped.

6. **"Try again" showed your question twice.** (`6777e49`)
   It re-sent the question as a new message. It now uses the AI SDK's `regenerate()`.

7. **`pnpm lint` failed with 8 React rule errors.** (`dc94ba2`)
   The chat page wrote to refs during render. It now uses the AI SDK's own APIs: one `Chat` object per conversation, with settings sent with each request.

8. **On laptop screens the welcome page was cut off.** (`59e3828`)
   At 1280×800 and below, the tagline sat under the top bar. At 1280×720 the "Preview an image source card" button was cut off and could not be reached. The area now scrolls, as it already did on phones.

9. **Sample answers with web search off showed leftover citation text** (`07edb57`), for example "credited to Tom Sodoge..jpg)".

I also added:

- `pnpm test` and `pnpm test:browser`
- `scripts/browser-smoke.mjs`, the real-browser checks, which need no keys
- `CONTEXT.md`, a glossary of Scout's terms
- an updated README

## Decisions I made for you (change any of them)

- **No new dependencies.** I kept the project's `node --test` runner. The browser checks use a global Playwright install, so `pnpm-lock.yaml` did not change.
- **I did not edit the vendored AI Elements code** for the switch bug. The fix is in `app/page.tsx` instead.
- Browser Use is now asked for a JSON-only reply. Its written summary was never used; your answer model writes the answer.
- If JEV returns an unexpected option, that is now logged as a fallback to Browser Use Cloud.
- I kept `<img>` for source images (2 lint warnings), because the images come from any website.
- **Delete this file before you merge.**

## Not fixed: needs you (most important first)

1. **`/api/chat` does not check who is calling.** It relies on the hosting keeping the site private. Anyone who can reach the URL can spend your model credit and up to $1 of Browser Use per question. `app/chatgpt-auth.ts` exists but nothing uses it. I suggest requiring a signed-in user in `/api/chat` (and `/api/config`). I did not do it, because the right check depends on how your Sites hosting passes the sign-in headers, and a wrong check would lock you out.
2. **Browser Use leaves a browser running after a finished run** (about 20 minutes, and it holds one of your concurrency slots). Stopping it takes two calls: list the browsers by the run's `sessionId`, then send `PATCH /api/v4/browsers/{id}` with `{"action":"stop"}`. I left this for you because I could not test it without a key.
3. **Polling cost.** Scout fetches the full Browser Use run every 1.8 seconds. The docs recommend the cheaper `GET /runs/{id}/status`, then one full fetch at the end.
4. **The JEV threshold may be stricter than you think.** JEV's "confidence" is not a probability. With two options, 0.65 confidence means Kernel is picked only when it is about 83% likely. Is that what you want?
5. **There is no CI.** A GitHub Actions workflow running typecheck, lint, test and build would catch problems like the lint errors. I did not add one, because it depends on your Sites build pipeline.
6. **The main JavaScript file is over 500 kB.** Loading the Mermaid and math plugins only when needed would make the first page load faster.
7. **Small things:**
   - The copy button's checkmark never goes away.
   - `ResearchActivity` has a "Research interrupted" label that can never show.
   - In a connected workspace, the sidebar's "Explore a research example" runs live research on the sample question. Is that intended?

## Bigger design ideas (proposed, not done)

- **Research run module (strong candidate).** The chat route is about 360 lines and mixes request checks, engine dispatch, Search API planning, evidence assembly and streaming. Move the research part behind one tested interface, for example `runResearch({ question, engine, keys, model, signal, onStep }) → { sources, warning, engine }`. The route would shrink to checks plus streaming, and the Search API path (untested today) could be tested with fake fetchers.

  ```
  Before: route.ts ─┬─ validation ─ engine choice ─ Search API plan/search/read ─ evidence ─ stream
  After:  route.ts ── validation ─ runResearch() ─ stream
                                     └─ engines (Browser Use, Kernel, Search API), tested behind one seam
  ```

- **Split `app/page.tsx` (strong candidate).** It is 1,100 lines. Pull out a `useConversations()` hook (device history as a proper store, which also removes the one lint exception), plus `Composer`, `AnswerMessage`, `SourceReader`, and the WebMCP tool.

**My recommendation:** do the research run module first. It protects the parts that cost money. Which of these do you want to explore?

## Glossary questions (from `CONTEXT.md`)

- "Sample mode", `demo` and `preview` overlap. Should one word mean all of them, or are they two separate ideas?
- The UI says "conversation" but the code says "thread". Should the code be renamed?
- The top-bar badge says "Connected" when any research engine is connected. Is that about the workspace, or about research?

## What I could not test

- **Live research with real keys** (Browser Use, Kernel, JEV, Tavily and your answer model). I checked every request shape against those services' current official docs (they all match) and tested with fake responses, but made no live calls.
- **The Android wrapper.** It was not built or run.
- Google Fonts failed to load in my sandbox. That is the sandbox's network, not an app bug.

## Commits on the branch (oldest first)

| Commit | Change |
| --- | --- |
| `07edb57` | Fix leftover citation fragments in web-off sample answers |
| `8f0a598` | Strip sentence punctuation from pasted links |
| `bacc960` | Parse Browser Use results that mix prose and JSON |
| `a04b914` | Log the real JEV outcome in the research steps |
| `e616b61` | Stop sending empty assistant turns to the model |
| `c82960d` | Add real-browser smoke checks for sample mode |
| `59e3828` | Let the empty workspace scroll on short desktop screens |
| `cade284` | Keep Sample and web search choices when a question is sent |
| `6777e49` | Make Try again regenerate the failed answer |
| `dc94ba2` | Fix the react-hooks lint errors in the chat page |
| `b0c233e` | Add pnpm test scripts and a CONTEXT.md glossary |

## Check it yourself

```sh
git fetch origin && git checkout claude/vigilant-archimedes-2m259a
pnpm install
pnpm exec tsc --noEmit && pnpm lint && pnpm test && pnpm build
pnpm dev                 # then, in another terminal:
pnpm test:browser        # needs Playwright: npm i -g playwright
```
