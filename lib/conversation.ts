import type { ModelMessage } from "ai";

type ChatTurn = { role: "user" | "assistant"; parts: Array<{ type: string; text?: string }> };

/** The model's view of a chat: recent text turns, and the question being asked. */
export function modelConversation(turns: ChatTurn[]): { messages: ModelMessage[]; question: string } {
  const messages: ModelMessage[] = turns
    .map((m) => ({
      role: m.role,
      content: m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("")
        .slice(0, 16000),
    }))
    // A turn with no text (an answer that failed before writing) would reach
    // the provider as an empty message, which stricter providers reject.
    .filter((m) => m.content)
    .slice(-16);
  const last = messages.at(-1);
  const question = last?.role === "user" ? String(last.content).trim() : "";
  return { messages, question };
}
