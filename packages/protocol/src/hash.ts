export async function sha256(content: ArrayBuffer | Uint8Array | string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bufferSource(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Hands the bytes to WebCrypto without copying them. Copying here doubled peak
 * memory when hashing large attachments.
 */
function bufferSource(content: ArrayBuffer | Uint8Array | string): BufferSource {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (!(content instanceof Uint8Array)) return content;
  // The cast only discounts a SharedArrayBuffer backing store, which no caller
  // in this codebase produces.
  return content as Uint8Array<ArrayBuffer>;
}
