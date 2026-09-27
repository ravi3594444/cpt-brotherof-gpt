import type { ModelMessage } from "ai";

type ChatPart = { type: string; text?: string; url?: string; mediaType?: string };
type ChatTurn = { role: "user" | "assistant"; parts: ChatPart[] };

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_PHOTOS = 4;
// Base64 characters per photo. Photos are shrunk on the device to 1280 px,
// which is far below this; it only stops oversized uploads.
export const MAX_PHOTO_CHARS = 2_000_000;

export class PhotoError extends Error {}

const isPhoto = (p: ChatPart) => p.type === "file";
const lastPhotoTurn = (turns: { role: string; parts: ChatPart[] }[]) =>
  turns.findLastIndex((t) => t.role === "user" && t.parts.some(isPhoto));

function photoImage(part: ChatPart) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.url || "");
  if (!match || match[1] !== part.mediaType || !PHOTO_TYPES.includes(match[1]))
    throw new PhotoError("Photos must be JPEG, PNG, or WebP images.");
  if (match[2].length > MAX_PHOTO_CHARS)
    throw new PhotoError("One of the photos is too large. Try a smaller photo.");
  return { type: "image" as const, image: match[2], mediaType: match[1] };
}

/**
 * The model's view of a chat: recent text turns, the question being asked, and
 * the photos of the latest question that has any. Throws PhotoError for photos
 * Scout does not accept.
 */
export function modelConversation(turns: ChatTurn[]): {
  messages: ModelMessage[];
  question: string;
  photos: number;
  images: Array<{ image: string; mediaType: string }>;
} {
  const photoTurn = lastPhotoTurn(turns);
  let images: Array<{ image: string; mediaType: string }> = [];
  const messages = turns
    .map((m, i) => {
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("")
        .slice(0, 16000);
      if (i !== photoTurn) return { text, message: { role: m.role, content: text } as ModelMessage };
      const photoParts = m.parts.filter(isPhoto);
      if (photoParts.length > MAX_PHOTOS) throw new PhotoError(`Add up to ${MAX_PHOTOS} photos per question.`);
      const imageParts = photoParts.map(photoImage);
      images = imageParts.map(({ image, mediaType }) => ({ image, mediaType }));
      const content = [{ type: "text" as const, text }, ...imageParts];
      return { text, message: { role: "user", content } as ModelMessage };
    })
    // A turn with no text and no photos (an answer that failed before writing)
    // would reach the provider as an empty message, which stricter providers reject.
    .filter(({ text, message }) => text || typeof message.content !== "string")
    .slice(-16)
    .map(({ message }) => message);
  const last = turns.at(-1);
  const question =
    last?.role === "user"
      ? last.parts.filter((p) => p.type === "text").map((p) => p.text || "").join("").trim()
      : "";
  return { messages, question, photos: images.length, images };
}

/** For an answer model that reads text only: replace the photos with the vision helper's description. */
export function withPhotoDescription(messages: ModelMessage[], description: string): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    return {
      role: "user",
      content: `${text}\n\n[The user attached photos, which you cannot see. A vision model described them:]\n${description}`,
    };
  });
}

/** The same turns as text only, for side calls such as planning that never need the photos. */
export function textOnlyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string"
        ? m.content
        : m.content.map((p) => (p.type === "text" ? p.text : "")).join(""),
    }) as ModelMessage)
    .filter((m) => m.content);
}

/** What the browser sends: text for every recent turn, photos only for the latest photo question. */
export function requestTurns<T extends { id: string; role: string; parts: ChatPart[] }>(messages: T[]) {
  const recent = messages.slice(-16);
  const photoTurn = lastPhotoTurn(recent);
  return recent.map((m, i) => ({
    id: m.id,
    role: m.role,
    parts: m.parts.filter((p) => p.type === "text" || (i === photoTurn && isPhoto(p))),
  }));
}

/** The message shown when the answer model fails for a reason Scout did not name itself. */
export function answerErrorMessage({ photos, aborted }: { photos: number; aborted: boolean }) {
  if (aborted) return "Research stopped or timed out. Please try again.";
  if (photos)
    return "The AI model could not answer. It may not be able to read photos: try again without them, or connect a model that reads images.";
  return "The model could not complete this request. Check your provider connection and try again.";
}
