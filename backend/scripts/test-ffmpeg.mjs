// Isolated ffmpeg transcoding test — no network, no Kie API
import { createRequire } from "module";
import { PassThrough } from "stream";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);

// Step A: confirm ffmpeg-static binary path
const ffmpegPath = require("ffmpeg-static");
console.log("ffmpeg-static path:", ffmpegPath);
console.log("ffmpeg binary exists:", fs.existsSync(ffmpegPath));

import ffmpeg from "fluent-ffmpeg";
ffmpeg.setFfmpegPath(ffmpegPath);

// Step B: generate a minimal valid MP3 in memory using a known-good tiny MP3 file
// This is a 1-second silent MP3 encoded as base64 (ID3v2 + MPEG frame headers, valid)
// Source: ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 1 -q:a 9 -acodec libmp3lame out.mp3
// We use a real 44-byte minimal MPEG frame to keep the test self-contained.
// If that's too small, ffmpeg may complain — we'll detect and report it.
const TINY_MP3_B64 =
  "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhgCenp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6e////////////////////////////////////////////////////////AAAAAExhdmM1OC41NAAAAAAAAAAAAAAAACQCkAAAAAAAA4YuZiMAAAAAAAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIADMIFHMPPCAIAkEgSBIHAcBwHAcDgOA4Dg+D4Pg+D4Pg+D4Pg4Hg+D4Pg+D4Ph8Hw+D4Pg+D8H//+D4Ph8Hg+D4Ph8H4fB8Hg+D4Ph8Hg+D4Ph8H4fBwHAcBwHA//tQxBYAC4whQGxhIAC4IFHMPPCIcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwH";

const mp3Buffer = Buffer.from(TINY_MP3_B64, "base64");
console.log("Test MP3 buffer byte length:", mp3Buffer.length);

// Step C: run through transcodeToMulaw8k logic inline
function transcodeToMulaw8k(inputBuffer, inputFormat) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const input = new PassThrough();
    input.end(inputBuffer);

    let command = ffmpeg(input);
    if (inputFormat) command = command.inputFormat(inputFormat);

    command
      .audioCodec("pcm_mulaw")
      .audioChannels(1)
      .audioFrequency(8000)
      .format("mulaw")
      .on("error", (err) => {
        console.error("ffmpeg error event:", err.message);
        reject(err);
      })
      .on("end", () => {
        console.log("ffmpeg end event — concatenating", chunks.length, "chunks");
        resolve(Buffer.concat(chunks));
      })
      .pipe()
      .on("data", (chunk) => {
        chunks.push(chunk);
      })
      .on("error", (err) => {
        console.error("pipe error event:", err.message);
        reject(err);
      });
  });
}

console.log("\n--- Starting transcode ---");
try {
  const output = await transcodeToMulaw8k(mp3Buffer, "mp3");
  console.log("Transcode SUCCEEDED. Output byte length:", output.length);

  // Step D: write result to disk
  const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-output.raw");
  fs.writeFileSync(outPath, output);
  console.log("Raw ulaw output written to:", outPath);
} catch (err) {
  console.error("\nTranscode FAILED.");
  console.error("Error message:", err.message);
  console.error("Stack:", err.stack);
  process.exit(1);
}
