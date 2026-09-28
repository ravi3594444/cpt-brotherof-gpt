# Scout context

Scout is a mobile-first research chat. When a question needs the web, it answers from public web pages that a research engine visited, and shows the sources, citations, and the steps it took, so the reader can check the answer. Other messages get a plain reply.

## Terms

| Term | Meaning | Avoid saying |
| --- | --- | --- |
| Question | The latest user message Scout is answering, 1 to 6000 characters. | prompt, query |
| Conversation | A user's questions and Scout's answers, kept on the device. Its Answer keeps running while another Conversation is on screen. | thread, chat (in UI copy) |
| Answer | Scout's reply to a Question, written by the Answer model, or after Research by the Research writer. | response, completion |
| Answer model | The OpenAI-compatible model that writes Answers, and decides whether a Question needs Research by calling the Research tool. Shown as "AI model". | LLM, JEV |
| Research writer | The model that writes the Answer after Research: the Vision model when one is connected (it is much faster than a reasoning Answer model), unless `RESEARCH_WRITER=answer` keeps the Answer model. If it fails before writing a word, the Answer model writes instead. | answer model (for the writer) |
| Research | Gathering Sources with a Research engine for the task the Answer model gave the Research tool, before the Answer is written. | search (when a browser does it) |
| Research tool | The `web_research` tool the Answer model calls when a Question needs Research, with a task, a Search query and a Research depth. The Answer model decides; Scout has no rules of its own for it. | search tool, auto-research |
| Search query | The short web search (at most about 10 words) the Research tool gives the engines to start with, instead of the task sentence. Without one, the task's first 12 words. | prompt, question |
| Research depth | How far Research goes: quick (the default: a few pages are enough) or deep (only when the user asks for thorough, comprehensive or detailed research, or for many sources or sites). It steers the engine choice, the Vision agent's pages and steps, and Browser Use Cloud's task. | mode, effort |
| Research engine | The service that gathers Sources: Browser Use Cloud, Kernel, or the Search API. | browser (for the Search API) |
| Research job | Research that runs outside the chat request, on Vercel Workflows: the research in steps of a few minutes, then the Answer in a step of its own. It has no time limit, keeps going when the app closes, and ends when it finishes, on Stop, or at the cost cap. Plain replies never start one. | background task, durable run |
| Resume | The app reading a Research job's Answer again from its start, after the app comes back, the connection returns, or its Conversation opens. The replay replaces what the app showed. | reconnect (in UI copy) |
| Research budget | The time Research may take for one Question when it runs inside the chat request (without Research jobs): it ends 200 seconds after the request starts (a second try, 220), so the Answer has time before the 280-second ceiling. A Research engine that needs more time than is left does not open its browser. | timeout |
| Partial result | The pages a browser agent had reached when it ran out of time or stopped early, kept as Sources that are not Read, with a warning. | partial answer |
| Auto | The Research engine setting that lets Scout choose the engine. | default engine |
| Browser Use Cloud | A hosted browser agent that navigates sites and returns page summaries. | Browser Use session (for Kernel) |
| Kernel | A separate hosted cloud browser that runs Scout's fixed page-reading script. | Browser Use |
| Vision model | An optional model that can see, used when the Answer model reads text only: it describes Photos and drives the Vision agent. | image model |
| Vision agent | A Research engine where the Vision model operates a real Kernel browser step by step and keeps the pages it read as Sources. It finishes by itself once it has kept 3 pages (quick) or 6 (deep). | Atria agent, browser bot |
| Search API | Tavily search and page extraction, kept as a compatibility fallback. | Tavily (in UI copy), legacy search |
| JEV | TypeSafe's hosted choice model, reached through AI/ML API or TypeSafe. In Auto, it picks the Research engine from the task and its Research depth, told that plain Kernel is the default and the fastest, the Vision agent for using a site like a person, and Browser Use Cloud only for tasks that need a heavy agent. It never answers or browses. | router model, on-device model |
| Source | A validated public web page used as evidence: title, URL, content, and optionally an image. | result, link |
| Read | True for a Source only when its content is page text a Research engine read directly. Search excerpts and browser-agent summaries are not Read. | verified |
| Evidence | The Sources given to the model that writes the Answer, marked as page content, search excerpt, or agent observation, with the Research engine's warning, such as a Partial result's. | context |
| Citation | A numbered link in an Answer, like [1](url), that points to one of the Question's Sources. | footnote, reference |
| Research steps | The visible log of actions the server actually took. They are not the model's reasoning; that is Thinking. | thoughts, chain of thought |
| Thinking | The Answer model's own reasoning before it writes (and the Research writer's), as its provider returns it (or a leading `<think>` block in its text), and any words the Answer model writes before it calls the Research tool, such as "I'll research…". Shown as one collapsed row, "Thinking…" then "Thought for N s", that opens to plain text. Not Research steps, which stay the server's actions. | chain of thought, reasoning (in UI copy) |
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
- An **Answer** has at most one **Research** record: its phase, the **Research steps** of every try in order, **Sources**, engine, and any warning.
- With **Search the web** on, the **Answer model** has the **Research tool** and calls it once per **Question**, only when the Question needs Research. It may call it once more only when that Research failed or found no Sources, at least 90 seconds of the ceiling remain, and the failure would not repeat (a rejected key, no credit, a rate limit, or a Browser Use Cloud run that may still be going); a third call never runs. An Answer it writes without the tool has no Research record and no **Citations**.
- When the provider cannot take tools, the **Answer model** makes the same choice as a one-word reply (RESEARCH or ANSWER); an unclear reply means Research.
- A **Citation** number n refers to the n-th **Source** of the same Answer's Research.
- An **Answer** can have **Thinking** from before and after the Research tool call; it shows as one row, above the Research panel when the model thought before researching. Words the Answer model writes before a Research tool call stream as they come, then move into Thinking once the call starts, so the Answer holds only what was written after Research.
- After **Research**, the **Research writer** writes the Answer from the Evidence, with the same rules as the Answer model. The Answer model still writes direct Answers, and decides whether to research and whether to retry a failed Research. Thinking is kept on the device, up to 20,000 characters per Answer (older Conversations give theirs up first when the device runs out of room), and never sent back to the **Answer model**.
- **Auto** asks **JEV** when two or more Research engines and the JEV key are connected. Without JEV, or when JEV fails, it prefers Kernel, then the Vision agent, then Browser Use Cloud for quick **Research depth**, and the Vision agent first for deep. JEV's Browser Use Cloud needs 65% confidence on a first try; an unsure Kernel answer stays Kernel for quick Research and becomes the Vision agent for deep. When JEV fails, the Research steps say why (such as "HTTP 402" or "timed out"). A second try leaves out the engines already tried, with Browser Use Cloud as the backup. With one browser connected, Auto uses it. With none, it uses the **Search API**.
- **Browser Use Cloud** Sources, including **Partial results**, are never **Read**; **Kernel** page text is Read; **Search API** Sources are Read only after page extraction succeeds.

## States and lifecycles

- **Research phase**: searching → reading → writing → complete. When Research fails and the Answer model is told why, it shows "Research incomplete" with the reason from then on, also while the Answer model decides whether to try again, and the Answer model says what happened. It shows "Research stopped" if the request is cut off or cancelled before complete.
- **Vision agent run**: it searches for the Search query (or opens a pasted link), then takes up to 8 steps in the request (16 for deep) or 10 in a Research job (40 for deep), and finishes once it has kept 3 pages (6 for deep). A reply with no action is asked once more, shorter; a second empty reply, or a model reply or browser step that fails, ends the run with the pages kept (or the readable page it is on), and fails it only when there is none. A stop still stops it.
- **Browser Use Cloud run**: queued → dispatching → running → completed, failed, or cancelled. Scout polls its status until the **Research budget** ends, then keeps the pages the agent reached as **Partial results** and cancels the run. After every run Scout stops its cloud browser.
- **Sample mode**: on until a Research engine is connected; the Sample switch overrides it for the current Conversation.
- **Thinking**: "Thinking…" with a live seconds count while a thought streams → "Thought for N s" when done. It shows "Thinking stopped" if the Answer ends mid-thought. Before the first part of an Answer arrives, the waiting line says "Thinking…" and adds the seconds after 3.
- **Answer run**: an Answer runs until it finishes, fails, or Stop ends it. Starting one, with a new Question or Try again, moves its Conversation to the top of the list. Opening another Conversation or a new one leaves it running, with a spinner on its Conversation in the sidebar and the folded rail; several can run at once. Deleting its Conversation, or forgetting the Access code, stops it. What it has written is saved about once a second as it streams, so a reload keeps the words so far, though the reload ends the Answer.

## Ambiguities

- "Sample mode", "demo", and "preview" name overlapping things. The code uses `demo` when no Answer model is connected (or for a sample Answer) and `preview` for the Sample switch; the UI says "Sample mode". One term, or two distinct ones? (to settle)
- "Conversation" in the UI and "thread" in the code are the same thing. Rename the code to match? (to settle)
- The top-bar badge says "Connected" when any Research engine is connected, while the settings panel uses "Connected" per service. Is the badge about the Workspace or about Research? (to settle)
