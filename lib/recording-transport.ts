import { contentHash, RECORDING_MAX_BYTES } from "./recording.ts";

export const COMPRESSED_RECORDING_FILE = "replay.json";
export const COMPRESSED_RECORDING_MAX_BYTES = 10 * 1024 * 1024;
const FORMAT = "chronosphere.compressed-recording";

async function boundedBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Expanded recording exceeds the 20 MB limit.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** A versioned text envelope keeps gzip bytes portable through gist APIs. */
export async function compressRecording(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength > RECORDING_MAX_BYTES) throw new Error("Recording exceeds the 20 MB limit.");
  const compressed = await boundedBytes(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")), RECORDING_MAX_BYTES + 1024 * 1024);
  const parts: string[] = [];
  for (let index = 0; index < compressed.length; index += 8192) parts.push(String.fromCharCode(...compressed.subarray(index, index + 8192)));
  const result = JSON.stringify({ format: FORMAT, version: 1, encoding: "gzip+base64", originalBytes: bytes.byteLength, sha256: await contentHash(source), data: btoa(parts.join("")) }) + "\n";
  if (new TextEncoder().encode(result).length > COMPRESSED_RECORDING_MAX_BYTES) throw new Error("Compressed recording exceeds the 10 MB limit. Use a plain committed replay or manual attachment.");
  return result;
}

/** Plain JSONL passes through; compressed data is bounded while expanding. */
export async function decompressRecording(source: string, requireCompressed = false): Promise<string> {
  const inputBytes = new TextEncoder().encode(source).length;
  if (inputBytes > RECORDING_MAX_BYTES) throw new Error("Recording exceeds the 20 MB import limit.");
  let envelope;
  try { envelope = JSON.parse(source); } catch { /* Multiple JSONL records are expected for plain recordings. */ }
  if (envelope?.format !== FORMAT) {
    if (requireCompressed) throw new Error("Expected a compressed Chronosphere recording in replay.json.");
    return source;
  }
  if (inputBytes > COMPRESSED_RECORDING_MAX_BYTES) throw new Error("Compressed recording exceeds the 10 MB limit.");
  if (envelope.version !== 1 || envelope.encoding !== "gzip+base64" || !Number.isSafeInteger(envelope.originalBytes)
    || envelope.originalBytes < 0 || envelope.originalBytes > RECORDING_MAX_BYTES
    || typeof envelope.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(envelope.sha256) || typeof envelope.data !== "string") {
    throw new Error("Invalid compressed recording metadata (maximum expanded size: 20 MB).");
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(envelope.data);
    // Reject whitespace, missing padding, and noncanonical encodings.
    if (btoa(binary) !== envelope.data) throw new Error("Invalid Base64");
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { throw new Error("Invalid Base64 in compressed recording."); }
  // Do not trust originalBytes to bound expansion: count streamed bytes independently.
  const expanded = await boundedBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), RECORDING_MAX_BYTES);
  if (expanded.byteLength !== envelope.originalBytes) throw new Error("Compressed recording size does not match its metadata.");
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(expanded);
  if (await contentHash(decoded) !== envelope.sha256) throw new Error("Compressed recording content hash does not match.");
  return decoded;
}
