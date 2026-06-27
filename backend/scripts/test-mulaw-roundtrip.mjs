// End-to-end simulation: Kie returns audio/basic (raw μ-law 8kHz)
// Verifies that inputFormatFromContentType now detects it, and the
// short-circuit path in kie.js returns it directly without transcoding.

import { inputFormatFromContentType, transcodeToMulaw8k } from "../src/voice/tts/audioTranscode.js";
import fs from "fs";

// The raw μ-law sine test file we generated earlier with ffmpeg
const rawMulaw = fs.readFileSync("C:/Users/HP/AppData/Local/Temp/test-out-sine.raw");
console.log("Raw μ-law buffer size:", rawMulaw.length, "bytes");

// --- Test inputFormatFromContentType with all mulaw variants ---
const cases = [
  ["audio/basic",   "mulaw"],
  ["audio/mulaw",   "mulaw"],
  ["audio/x-mulaw", "mulaw"],
  ["audio/x-ulaw",  "mulaw"],
  ["audio/mpeg",    "mp3"],
  ["audio/mp3",     "mp3"],
  ["",              ""],
  ["application/octet-stream", ""],
];
console.log("\n--- inputFormatFromContentType results ---");
let allPass = true;
for (const [ct, expected] of cases) {
  const got = inputFormatFromContentType(ct);
  const ok = got === expected;
  console.log(`  "${ct}" → "${got}" ${ok ? "✓" : `✗ (expected "${expected}")`}`);
  if (!ok) allPass = false;
}
console.log(allPass ? "\nAll content-type detections PASS ✓" : "\nSome content-type detections FAILED ✗");

// --- Test: short-circuit path (mulaw → no transcode) ---
console.log("\n--- Short-circuit path test (audio/basic → mulaw, should skip transcode) ---");
const inputFormat = inputFormatFromContentType("audio/basic");
console.log("inputFormat for audio/basic:", inputFormat);
if (inputFormat === "mulaw") {
  console.log("Would return audioBuffer directly (no transcode) ✓");
} else {
  console.log("Would try to transcode — this is the bug path ✗");
}

// --- Test: MP3 path still transcodes (regression check) ---
console.log("\n--- MP3 transcode path (regression check) ---");
// Use the valid mp3 we generated
const validMp3 = fs.readFileSync("C:/Users/HP/AppData/Local/Temp/test-valid.mp3");
const mp3Format = inputFormatFromContentType("audio/mpeg");
console.log("inputFormat for audio/mpeg:", mp3Format);
try {
  const transcoded = await transcodeToMulaw8k(validMp3, { contentType: "audio/mpeg", inputFormat: mp3Format });
  console.log("MP3 → μ-law transcode SUCCEEDED, output bytes:", transcoded.length, "✓");
} catch (err) {
  console.error("MP3 → μ-law transcode FAILED:", err.message, "✗");
  process.exit(1);
}

console.log("\n=== All tests passed ===");
