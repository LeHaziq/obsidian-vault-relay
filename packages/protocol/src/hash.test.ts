import { describe, expect, it } from "vitest";
import { sha256 } from "./hash.js";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ZERO_BYTE = "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d";
const BINARY = "52561baaac3c462b483af07a4b8fbd0774e8b4bf1dd90130e71476ef249649df";

describe("sha256", () => {
  it("hashes a string against the published vector", async () => {
    expect(await sha256("abc")).toBe(ABC);
  });

  it("hashes empty content in each accepted form", async () => {
    expect(await sha256("")).toBe(EMPTY);
    expect(await sha256(new Uint8Array(0))).toBe(EMPTY);
    expect(await sha256(new ArrayBuffer(0))).toBe(EMPTY);
  });

  it("gives the same digest for a string and for its UTF-8 bytes", async () => {
    const text = "héllo wörld";
    const bytes = new TextEncoder().encode(text);
    expect(await sha256(bytes)).toBe(await sha256(text));
    expect(await sha256(bytes.slice().buffer)).toBe(await sha256(text));
  });

  it("hashes binary content, including bytes that are not valid text", async () => {
    expect(await sha256(new Uint8Array([0x00]))).toBe(ZERO_BYTE);
    const binary = new Uint8Array([0x00, 0xff, 0x10, 0x00]);
    expect(await sha256(binary)).toBe(BINARY);
    expect(await sha256(binary)).not.toBe(await sha256(new Uint8Array([0xff, 0x00, 0x10, 0x00])));
  });

  it("hashes only the bytes of a view, not the whole backing buffer", async () => {
    // The digest goes to WebCrypto without a copy, so a view over a larger
    // buffer must still hash its own window.
    const view = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 3);
    expect(await sha256(view)).toBe(await sha256(new Uint8Array([2, 3])));
  });

  it("returns 64 lowercase hex characters, keeping the leading zero of a small byte", async () => {
    // This vector holds bytes below 0x10. An unpadded byte would make the
    // digest shorter than 64 characters.
    expect(await sha256(new Uint8Array([0x00]))).toMatch(/^[0-9a-f]{64}$/);
  });
});
