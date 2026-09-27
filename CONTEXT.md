# Scout context

Scout is a mobile-first research chat. When a question needs the web, it answers from public web pages that a research engine visited, and shows the sources, citations, and the steps it took, so the reader can check the answer. Other messages get a plain reply.

## Terms

| Term | Meaning | Avoid saying |
| --- | --- | --- |
| Question | The latest user message Scout is answering, 1 to 6000 characters. | prompt, query |
| Conversation | A user's questions and Scout's answers, kept on the device. Its Answer keeps running while another Conversation is on screen. | thread, chat (in UI copy) |
| Answer | Scout's reply to a Question, written by the Answer model. | response, completion |
| Answer model | The OpenAI-compatible model that writes Answers, and decides whether a Question needs Research by calling the Research tool. Shown as "AI model". | LLM, JEV |
| Research | Gathering Sources with a Research engine for the task the Answer model gave the Research tool, before the Answer is written. | search (when a browser does it) |
| Research tool | The `web_research` tool the Answer model calls when a Question needs Research. The Answer model decides; Scout has no rules of its own for it. | search tool, auto-research |
| Research engine | The service that gathers Sources: Browser Use Cloud, Kernel, or the Search API. | browser (for the Search API) |
| Auto | The Research engine setting that lets Scout choose the engine. | default engine |
| Browser Use Cloud | A hosted browser agent that navigates sites and returns page summaries. | Browser Use session (for Kernel) |
| Kernel | A separate hosted cloud browser that runs Scout's fixed page-reading script. | Browser Use |
| Vision model | An optional model that can see, used when the Answer model reads text only: it describes Photos and drives the Vision agent. | image model |
| Vision agent | A Research engine where the Vision model operates a real Kernel browser step by step and keeps the pages it read as Sources. | Atria agent, browser bot |
| Search API | Tavily search and page extraction, kept as a compatibility fallback. | Tavily (in UI copy), legacy search |
| JEV | TypeSafe's hosted choice model, reached through AI/ML API or TypeSafe. In Auto, it picks Kernel or Browser Use Cloud. It never answers or browses. | router model, on-device model |
| Source | A validated public web page used as evidence: title, URL, content, and optionally an image. | result, link |
| Read | True for a Source only when its content is page text a Research engine read directly. Search excerpts and browser-agent summaries are not Read. | verified |
| Evidence | The Sources given to the Answer model, marked as page content, search excerpt, or agent observation. | context |
| Citation | A numbered link in an Answer, like [1](url), that points to one of the Question's Sources. | footnote, reference |
| Research steps | The visible log of actions the server actually took. They are not the model's reasoning. | thoughts, chain of thought |
| Sample mode | Prepared Answers and Sources that show the interface. It never browses or calls a model. | demo mode, preview |
| Live chat | The Answer model with Search the web off or no Research engine connected. It gives no Citations. | chat mode |
| Search the web | The composer switch that gives the Answer model the Research tool. Off means no tool, so no Research. | web mode |
| Workspace | One Scout deployment and the server keys it has connected. | account, project |
| Access code | An optional secret the Workspace owner sets; Scout asks for it once per device before anyone can use the Workspace's keys. | password, login |
| Source card | A tile for one Source in the sideways row under an Answer, with the page's picture if it has one. | preview card |
| Photo | A JPEG, PNG, or WebP picture the user attaches to a Question, up to 4. Only the Answer model sees it; Research uses the words of the Research tool's task. | image upload, attachment |
| Suggestion chip | A suggested first Question on the home screen. | prompt card |
| Behind the answer | The panel listing every Source of an Answer with its content. | reader, source drawer |
| Follow-up suggestion | A suggested next Question shown after a Sample mode Answer. | prompt chip |
| Phone browser track | The planned native Android browser and on-device model. It is not built. | Android app (for the wrapper) |

## Relationships

- A **Conversation** holds Questions and Answers in order.
- An **Answer** has at most one **Research** record: its phase, **Research steps**, **Sources**, engine, and any warning.
- With **Search the web** on, the **Answer model** has the **Research tool** and calls it at most once per **Question**, only when the Question needs Research. An Answer it writes without the tool has no Research record and no **Citations**.
- When the provider cannot take tools, the **Answer model** makes the same choice as a one-word reply (RESEARCH or ANSWER); an unclear reply means Research.
- A **Citation** number n refers to the n-th **Source** of the same Answer's Research.
- **Auto** asks **JEV** only when Browser Use Cloud, Kernel, and the JEV key are all connected. With one browser connected, Auto uses it. With none, it uses the **Search API**.
- **Browser Use Cloud** Sources are never **Read**; **Kernel** page text is Read; **Search API** Sources are Read only after page extraction succeeds.

## States and lifecycles

- **Research phase**: searching → reading → writing → complete. It shows "Research stopped" if the request ends before complete, or if Research fails; the Answer model then says it failed.
- **Browser Use Cloud run**: queued → dispatching → running → completed, failed, or cancelled.
- **Sample mode**: on until a Research engine is connected; the Sample switch overrides it for the current Conversation.
- **Answer run**: an Answer runs until it finishes, fails, or Stop ends it. Opening another Conversation or a new one leaves it running, with a spinner on its Conversation in the sidebar and the folded rail; several can run at once. Deleting its Conversation stops it. What it has written is saved about once a second as it streams, so a reload keeps the words so far, though the reload ends the Answer.

## Ambiguities

- "Sample mode", "demo", and "preview" name overlapping things. The code uses `demo` when no Answer model is connected (or for a sample Answer) and `preview` for the Sample switch; the UI says "Sample mode". One term, or two distinct ones? (to settle)
- "Conversation" in the UI and "thread" in the code are the same thing. Rename the code to match? (to settle)
- The top-bar badge says "Connected" when any Research engine is connected, while the settings panel uses "Connected" per service. Is the badge about the Workspace or about Research? (to settle)
