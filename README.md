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

The interface supports new chats, follow-ups, device-local history, source
cards, an image when a source provides one, citations, copy-with-sources, and
stop generation. The responsive layout is designed for Android-sized screens.

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
| `TYPESAFE_API_KEY` | Optional JEV routing between the two browser services |
| `TAVILY_API_KEY` | Optional legacy search/extraction fallback |

For live research, connect the model plus Browser Use **or** Kernel. The two
browser keys together enable engine choice in the chat. JEV is optional and
only selects the path in Auto mode. It does not browse, answer, or run locally
on Android. The current private preview already has its answer model
configured; its browser services still need keys. Never commit real keys or
put them in `NEXT_PUBLIC_` variables.

See [harness and tool schemas](docs/harness-and-tools.md) for the run sequence,
request and response types, provider API shapes, cancellation behavior,
cost ceiling, and Android integration boundary.

## Development

Requires Node 22.13+ and pnpm:

```sh
pnpm install
pnpm dev
pnpm exec tsc --noEmit
pnpm lint
pnpm test          # unit tests for research, engine choice, links, and samples
pnpm build
```

With `pnpm dev` running, `pnpm test:browser` drives sample mode in Chromium:
answers, citations, history, Try again, the composer switches, a stubbed
connected workspace, and the layout at desktop and phone sizes. It needs no
keys and uses Playwright from the project or a global install.

`CONTEXT.md` is the glossary of Scout's domain terms.

The AI Elements code in `components/ai-elements` comes from the official
Vercel AI Elements project under Apache-2.0. The hosting build uses Cloudflare
Workers; `scripts/install-pnpm.sh` and `scripts/build-site.mjs` support the
managed Sites environment.

## Android

`android/` is a Capacitor wrapper with app ID `app.scout.research`. It opens
the private hosted preview over HTTPS and needs internet access. Android Studio
and an Android SDK can build a debug APK locally after `pnpm exec cap sync
android`; no APK has been built or device-tested in this workspace.

The native on-phone browser/model track is specified in the harness document.
The wrapper does **not** control Chrome or contain local model weights.
Finishing native autonomy requires choosing a supported Android model/runtime,
implementing the WebView action executor, testing it on the target phone, and
adding device authentication for a distributable build. The Sites preview
does not simulate those native permissions.

## Tests and current limits

Mocked adapter tests verify Browser Use run parsing (including prose around
JSON), image/source validation, Kernel session cleanup, engine choice and the
logged JEV outcome, pasted-link extraction, conversation preparation, and
legacy search error behavior. A
TypeScript check and production build cover the UI and API. The provider
paths cannot be tested end-to-end without the separate Browser Use, Kernel,
and optional TypeSafe keys. Browser Use Cloud runs are capped at one US dollar
per question; page summaries should always be checked against the links.
