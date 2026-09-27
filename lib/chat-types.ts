import type { UIMessage } from "ai";
export type ResearchSource = {
  title: string;
  url: string;
  content: string;
  read?: boolean;
  image?: string;
};
export type ResearchData = {
  phase: "searching" | "reading" | "writing" | "complete";
  queries: string[];
  sources: ResearchSource[];
  demo: boolean;
  warning?: string;
  // Research failed and the answer model was told why (the warning): "Research incomplete".
  failed?: boolean;
  engine?: "browser_use" | "kernel" | "vision_agent" | "tavily";
  steps?: string[];
};
export type ScoutMessage = UIMessage<
  // thinkingMs: how long the Answer model's finished thoughts took in all.
  { demo?: boolean; thinkingMs?: number },
  { research: ResearchData; suggestions: string[] }
>;
export type ScoutConfig = {
  // "required" hides the workspace until the right access code is sent.
  access: "open" | "granted" | "required";
  demo: boolean;
  modelConnected: boolean;
  searchConnected: boolean;
  modelName: string;
  engines: {
    browserUse: boolean;
    kernel: boolean;
    // A vision model driving a Kernel browser; needs both keys.
    visionAgent: boolean;
    tavily: boolean;
    jev: boolean;
    // A vision model for photos and the vision agent.
    vision: boolean;
  };
};
export type LocalThread = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ScoutMessage[];
};
export const DEMO_QUESTION = "How do AI agents search the web?";
// The sample that shows a source card with a picture.
export const PHOTO_SAMPLE = {
  text: "Show me a photo source card",
  label: "See a source with a picture",
  category: "Sample",
  icon: "image",
} as const;
export const SUGGESTIONS = [
  {
    text: "How do AI agents search the web?",
    label: "Understand something",
    category: "Explore a topic",
    icon: "globe",
  },
  {
    text: "Compare React and Next.js for a new app",
    label: "React or Next.js for my next app?",
    category: "Compare options",
    icon: "compare",
  },
  {
    text: "How can I check if a source is reliable?",
    label: "What makes a source trustworthy?",
    category: "Go a little deeper",
    icon: "book",
  },
] as const;
export function messageText(message: ScoutMessage) {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}
/** The Answer model's Thinking in a message: every thought's text, a blank line apart. */
export function thinkingData(message: ScoutMessage) {
  const thoughts = message.parts.filter((p) => p.type === "reasoning");
  if (!thoughts.length) return;
  const first = message.parts.findIndex((p) => p.type === "reasoning");
  const research = message.parts.findIndex((p) => p.type === "data-research");
  return {
    text: thoughts.map((p) => p.text.trim()).filter(Boolean).join("\n\n"),
    thoughts: thoughts.length,
    streaming: thoughts.some((p) => p.state === "streaming"),
    // Thinking before the Research tool call shows above the research panel.
    beforeResearch: research < 0 || first < research,
  };
}
export function researchData(message: ScoutMessage): ResearchData | undefined {
  return message.parts.findLast((p) => p.type === "data-research")?.data as
    ResearchData | undefined;
}
export function safeSourceUrl(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    if (u.username || u.password) return;
    return u.href;
  } catch {
    return;
  }
}
