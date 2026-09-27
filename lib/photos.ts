// Photos a user attaches to a question. They are shrunk on the device before
// sending, and conversation history keeps only a small thumbnail of each.

export const SEND_SIZE = 1280;
export const THUMBNAIL_SIZE = 200;

/** Width and height that fit inside max×max, keeping the shape and never enlarging. */
export function fitWithin(width: number, height: number, max: number) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// Sent photo URL → its thumbnail, so saved history stays small.
const thumbnails = new Map<string, string>();

function drawJpeg(image: HTMLImageElement, max: number, quality: number) {
  const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight, max);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  // JPEG has no transparency; give transparent PNGs a white background.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Shrink an attached photo to a JPEG for sending, and remember its thumbnail. */
export async function preparePhoto(file: { url: string; filename?: string }) {
  const image = new Image();
  image.src = file.url;
  await image.decode();
  const url = drawJpeg(image, SEND_SIZE, 0.82);
  thumbnails.set(url, drawJpeg(image, THUMBNAIL_SIZE, 0.7));
  return { type: "file" as const, mediaType: "image/jpeg", url, filename: file.filename || "photo.jpg" };
}

/** The photo URL to keep in saved history: its thumbnail, or nothing if unknown and large. */
export function historyPhotoUrl(url: string) {
  return thumbnails.get(url) ?? (url.length > 60_000 ? "" : url);
}
