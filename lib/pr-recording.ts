export const PR_RECORDING_PATH = ".chronosphere/replay.jsonl";

/** The attached log is review metadata, never input to code reconstruction or AI review. */
export function withoutRecordingDiff(diff: string): string {
  return diff.split(/(?=^diff --git )/m).filter((section) => {
    const header = section.split("\n", 1)[0];
    return header !== `diff --git a/${PR_RECORDING_PATH} b/${PR_RECORDING_PATH}`;
  }).join("");
}

/** Bound the raw download before decoding or parsing a committed recording. */
export async function readRecordingResponse(response: Response, limit = 20 * 1024 * 1024): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Recording exceeds the 20 MB import limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Recording exceeds the 20 MB import limit."); }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}
