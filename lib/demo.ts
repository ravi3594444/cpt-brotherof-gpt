import type { ResearchSource } from "./chat-types";
export function demoAnswer(
  question: string,
  { photos = 0 }: { photos?: number } = {},
): {
  text: string;
  sources: ResearchSource[];
  suggestions: string[];
} {
  if (photos)
    return {
      text: "**Sample mode can't look at photos.** Prepared answers only cover the example questions. Connect an AI model that reads images, then ask about your photo again.",
      sources: [],
      suggestions: ["How do AI agents search the web?", "Show me a photo source card"],
    };
  const q = question.toLowerCase().replace(/[?.!]/g, "").trim();
  if (q === "show me a photo source card")
    return {
      text: "Here is an example of a **visual source card**. The photo is an archived image of red Nike shoes, credited to Tom Sodoge. [1](https://commons.wikimedia.org/wiki/File:Mens_red_Nike_shoes_(Unsplash).jpg)\n\nTap the photo card to open its original Wikimedia Commons record. This sample does not show a current product listing or live availability. When connected, the same card format works for any research topic whose visited sources provide an image.",
      sources: [{
        title: "Red Nike shoes · photo by Tom Sodoge",
        url: "https://commons.wikimedia.org/wiki/File:Mens_red_Nike_shoes_(Unsplash).jpg",
        image: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c0/Mens_red_Nike_shoes_%28Unsplash%29.jpg/330px-Mens_red_Nike_shoes_%28Unsplash%29.jpg",
        content: "Wikimedia Commons credits this 2015 photo of red Nike shoes to Tom Sodoge. This archived editorial image is not a live store listing.",
      }],
      suggestions: ["How do AI agents search the web?", "How can I check if a source is reliable?"],
    };
  if (
    q === "how do ai agents search the web" ||
    q === "show me how scout researches a question"
  )
    return {
      text: `An AI research assistant connects **a language model with browser tools**. The browser visits pages, then the model explains what it found and links the original evidence.\n\n### From your question to a sourced answer\n\n1. **Navigate.** Browser Use Cloud can run a managed browser agent to explore several pages. [1](https://docs.browser-use.com/cloud/api-v4/runs/create-run)\n2. **Read.** Kernel can run Playwright in a separate cloud browser to inspect public pages. [2](https://www.kernel.sh/docs/api-reference/browser-playwright/execute-playwrighttypescript-code-against-the-browser)\n3. **Explain and cite.** Scout writes from the browser's evidence and shows source links in its Vercel AI Elements interface. [3](https://elements.ai-sdk.dev/components/sources)\n\n**For Scout, that means:** ask naturally, follow the visible browser steps, and open the original pages. This is a prepared example; no live browser ran for this sample.`,
      sources: [
        {
          title: "Browser Use Cloud: managed browser agent",
          url: "https://docs.browser-use.com/cloud/api-v4/runs/create-run",
          content:
            "Browser Use Cloud accepts a task, runs it in its managed browser, and returns the run result.",
        },
        {
          title: "Kernel: execute Playwright in a browser",
          url: "https://www.kernel.sh/docs/api-reference/browser-playwright/execute-playwrighttypescript-code-against-the-browser",
          content:
            "Kernel executes Playwright code against a cloud browser session and returns the result.",
        },
        {
          title: "Show the sources behind an AI answer",
          url: "https://elements.ai-sdk.dev/components/sources",
          content:
            "Vercel’s AI Elements provides Sources, SourcesTrigger, SourcesContent, and Source components to display the references used in a response.",
        },
      ],
      suggestions: [
        "How can I check if a source is reliable?",
        "What does Scout need for live research?",
      ],
    };
  if (
    q === "compare react and nextjs for a new app" ||
    q === "compare react and next.js for a new app"
  )
    return {
      text: `**React is the UI library; Next.js is a framework built around React.** You can use React with your own choice of routing and server tools, or choose a framework that brings those pieces together. [1](https://react.dev/learn) [2](https://nextjs.org/docs)\n\n| Your need | What to consider |\n|---|---|\n| Interactive UI with an existing backend | React with a suitable build tool can be enough. |\n| Routing and server rendering in one project | Next.js provides a framework for those concerns. |\n| Reusable interface components | Both use React components. |\n\n### For a research chat app\n\nMy design recommendation is a React interface plus a server endpoint for the model and search calls. That keeps API keys off the device and gives the app one place to handle streaming and source retrieval. A React framework can provide that endpoint alongside the UI.\n\nThis is a prepared comparison, not a fresh benchmark.`,
      sources: [
        {
          title: "React: components and interactive interfaces",
          url: "https://react.dev/learn",
          content:
            "React’s Quick Start covers components, JSX, state, events, and sharing data between components.",
        },
        {
          title: "Next.js: a React framework",
          url: "https://nextjs.org/docs",
          content:
            "Next.js documentation describes building full-stack React applications, with framework features including routing and rendering.",
        },
      ],
      suggestions: [
        "How do AI agents search the web?",
        "What does Scout need for live research?",
      ],
    };
  if (q === "how can i check if a source is reliable")
    return {
      text: `**Treat citations as a starting point for checking an answer.** A link is useful when the page actually supports the claim next to it.\n\nHere is a practical checklist I suggest:\n\n- **Find the original.** Prefer the study, documentation, public record, or first-hand account over a summary of a summary.\n- **Check the author and date.** Ask who produced it, what expertise they have, and whether the information is current enough for your question.\n- **Read the supporting evidence.** Look for the data, methods, or passage behind the claim.\n- **Compare independent sources.** Several pages repeating one announcement are still only one underlying source.\n- **Notice uncertainty.** Conflicting evidence should appear in the answer rather than disappear during summarization.\n\nThese are suggested reading habits. UNESCO’s media and information literacy resources provide broader context on critically engaging with information. [1](https://www.unesco.org/en/media-information-literacy)\n\nIn Scout, open **Behind the answer** to inspect the source details and follow a link to the original page. This is a prepared sample answer.`,
      sources: [
        {
          title: "Media and information literacy",
          url: "https://www.unesco.org/en/media-information-literacy",
          content:
            "UNESCO’s media and information literacy work focuses on helping people engage critically with information and media.",
        },
      ],
      suggestions: [
        "How do AI agents search the web?",
        "What does Scout need for live research?",
      ],
    };
  if (q === "what does scout need for live research")
    return {
      text: "Scout needs an **OpenAI-compatible model connection** plus a **Browser Use Cloud or Kernel key** for live browser research. Connect both browser services to switch between agent navigation and faster page reading. A TypeSafe key optionally enables JEV routing between them.\n\nThe model writes the answer from retrieved evidence. Credentials stay on the server and never go into the Android wrapper.\n\nOnce connected, ask any research question, paste public page links, compare findings, and follow up in the same conversation.",
      sources: [],
      suggestions: ["How do AI agents search the web?"],
    };
  return {
    text: "**This is sample mode.** It shows prepared conversations and source cards, but it cannot research a new question. Turn off Sample for live chat, and connect Browser Use Cloud or Kernel for live web research.\n\nTry one of the example questions below to explore the research interface.",
    sources: [],
    suggestions: [
      "How do AI agents search the web?",
      "Compare React and Next.js for a new app",
      "How can I check if a source is reliable?",
    ],
  };
}
// Numbered citations like [1](url), for sample answers shown with web search off.
// A URL may contain one level of balanced parentheses, as Wikimedia file names do.
export function withoutCitations(text: string): string {
  return text.replace(/\s*\[\d+\]\(https?:\/\/(?:[^()\s]|\([^()\s]*\))+\)/g, "");
}
