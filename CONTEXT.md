# Scout context

Scout is a mobile-first research chat. It answers a question from public web pages that a research engine visited, and shows the sources, citations, and the steps it took, so the reader can check the answer.

## Terms

| Term | Meaning | Avoid saying |
| --- | --- | --- |
| Question | The latest user message Scout is answering, 1 to 6000 characters. | prompt, query |
| Conversation | A user's questions and Scout's answers, kept on the device. | thread, chat (in UI copy) |
| Answer | Scout's reply to a Question, written by the Answer model. | response, completion |
| Answer model | The OpenAI-compatible model that writes Answers from Evidence. Shown as "AI model". | LLM, JEV |
| Research | Gathering Sources for a Question with a Research engine before the Answer is written. | search (when a browser does it) |
| Research engine | The service that gathers Sources: Browser Use Cloud, Kernel, or the Search API. | browser (for the Search API) |
| Auto | The Research engine setting that lets Scout choose the engine. | default engine |
| Browser Use Cloud | A hosted browser agent that navigates sites and returns page summaries. | Browser Use session (for Kernel) |
| Kernel | A separate hosted cloud browser that runs Scout's fixed page-reading script. | Browser Use |
| Search API | Tavily search and page extraction, kept as a compatibility fallback. | Tavily (in UI copy), legacy search |
| JEV | TypeSafe's hosted choice model. In Auto, it picks Kernel or Browser Use Cloud. It never answers or browses. | router model, on-device model |
| Source | A validated public web page used as evidence: title, URL, content, and optionally an image. | result, link |
| Read | True for a Source only when its content is page text a Research engine read directly. Search excerpts and browser-agent summaries are not Read. | verified |
| Evidence | The Sources given to the Answer model, marked as page content, search excerpt, or agent observation. | context |
| Citation | A numbered link in an Answer, like [1](url), that points to one of the Question's Sources. | footnote, reference |
| Research steps | The visible log of actions the server actually took. They are not the model's reasoning. | thoughts, chain of thought |
| Sample mode | Prepared Answers and Sources that show the interface. It never browses or calls a model. | demo mode, preview |
| Live chat | The Answer model with Search the web off or no Research engine connected. It gives no Citations. | chat mode |
| Search the web | The composer switch that decides whether Research runs before the Answer. | web mode |
| Workspace | One Scout deployment and the server keys it has connected. | account, project |
| Source card | A tile for one Source in the sideways row under an Answer, with the page's picture if it has one. | preview card |
| Photo | A JPEG, PNG, or WebP picture the user attaches to a Question, up to 4. Only the Answer model sees it; Research uses the typed words. | image upload, attachment |
| Suggestion chip | A suggested first Question on the home screen. | prompt card |
| Behind the answer | The panel listing every Source of an Answer with its content. | reader, source drawer |
| Follow-up suggestion | A suggested next Question shown after a Sample mode Answer. | prompt chip |
| Phone browser track | The planned native Android browser and on-device model. It is not built. | Android app (for the wrapper) |

## Relationships

- A **Conversation** holds Questions and Answers in order.
- An **Answer** has at most one **Research** record: its phase, **Research steps**, **Sources**, engine, and any warning.
- A **Citation** number n refers to the n-th **Source** of the same Answer's Research.
- **Auto** asks **JEV** only when Browser Use Cloud, Kernel, and the JEV key are all connected. With one browser connected, Auto uses it. With none, it uses the **Search API**.
- **Browser Use Cloud** Sources are never **Read**; **Kernel** page text is Read; **Search API** Sources are Read only after page extraction succeeds.

## States and lifecycles

- **Research phase**: searching → reading → writing → complete. It shows "Research stopped" if the request ends before complete.
- **Browser Use Cloud run**: queued → dispatching → running → completed, failed, or cancelled.
- **Sample mode**: on until a Research engine is connected; the Sample switch overrides it for the current Conversation.

## Ambiguities

- "Sample mode", "demo", and "preview" name overlapping things. The code uses `demo` when no Answer model is connected (or for a sample Answer) and `preview` for the Sample switch; the UI says "Sample mode". One term, or two distinct ones? (to settle)
- "Conversation" in the UI and "thread" in the code are the same thing. Rename the code to match? (to settle)
- The top-bar badge says "Connected" when any Research engine is connected, while the settings panel uses "Connected" per service. Is the badge about the Workspace or about Research? (to settle)
