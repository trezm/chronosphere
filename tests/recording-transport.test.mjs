import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { compressRecording, decompressRecording, COMPRESSED_RECORDING_MAX_BYTES } from "../lib/recording-transport.ts";
import { contentHash, RECORDING_MAX_BYTES } from "../lib/recording.ts";

test("compressed Unicode recordings round-trip exactly and plain JSONL remains compatible", async () => {
  const source = '{"text":"repeat 🙂 café"}\n'.repeat(2000);
  const encoded = await compressRecording(source);
  const envelope = JSON.parse(encoded);
  assert.equal(envelope.encoding, "gzip+base64");
  assert.equal(envelope.originalBytes, Buffer.byteLength(source));
  assert.ok(Buffer.byteLength(encoded) < Buffer.byteLength(source) / 5);
  assert.equal(await decompressRecording(encoded), source);
  assert.equal(await decompressRecording(source), source);
  assert.equal(await decompressRecording('{"type":"session"}\n'), '{"type":"session"}\n');
  await assert.rejects(decompressRecording(source, true), /Expected a compressed/);
});

test("compressed imports reject altered metadata, payloads and hashes", async () => {
  const envelope = JSON.parse(await compressRecording("original\n"));
  for (const patch of [{ version: 2 }, { encoding: "brotli" }, { originalBytes: -1 }, { originalBytes: RECORDING_MAX_BYTES + 1 }, { originalBytes: 3.5 }, { sha256: "invalid" }]) {
    await assert.rejects(decompressRecording(JSON.stringify({ ...envelope, ...patch })), /metadata/);
  }
  await assert.rejects(decompressRecording(JSON.stringify({ ...envelope, sha256: "0".repeat(64) })), /hash/);
  await assert.rejects(decompressRecording(JSON.stringify({ ...envelope, originalBytes: 1 })), /size does not match/);
  await assert.rejects(decompressRecording(JSON.stringify({ ...envelope, data: "!invalid" })), /Base64/);
  await assert.rejects(decompressRecording(JSON.stringify({ ...envelope, data: envelope.data + "\n" })), /Base64/);
  const broken = Buffer.from(envelope.data, "base64");
  broken[broken.length - 5] ^= 0xff;
  await assert.rejects(decompressRecording(JSON.stringify({ ...envelope, data: broken.toString("base64") })));
});

test("gzip expansion is bounded independently of a forged small declared size", async () => {
  const envelope = JSON.parse(await compressRecording("small"));
  const bomb = gzipSync(Buffer.alloc(RECORDING_MAX_BYTES + 1, 97));
  assert.ok(bomb.length < 100_000);
  await assert.rejects(decompressRecording(JSON.stringify({ ...envelope, data: bomb.toString("base64") })), /Expanded recording exceeds/);
});

test("limits apply before decoding and exporting as well as after decompression", async () => {
  await assert.rejects(compressRecording("a".repeat(RECORDING_MAX_BYTES + 1)), /20 MB/);
  await assert.rejects(decompressRecording("a".repeat(RECORDING_MAX_BYTES + 1)), /20 MB/);
  const envelope = JSON.parse(await compressRecording("small"));
  await assert.rejects(decompressRecording(JSON.stringify({ ...envelope, data: "a".repeat(COMPRESSED_RECORDING_MAX_BYTES) })), /10 MB/);
});

test("invalid UTF-8 gzip content cannot become a valid text recording", async () => {
  const envelope = { format: "chronosphere.compressed-recording", version: 1, encoding: "gzip+base64", originalBytes: 1, sha256: await contentHash("x"), data: gzipSync(Buffer.from([0xff])).toString("base64") };
  await assert.rejects(decompressRecording(JSON.stringify(envelope)), /encoded|encoding/i);
});
