// Test ffmpeg with file-based I/O (workaround for Windows pipe:0 issue)
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");
console.log("ffmpeg path:", ffmpegPath, "exists:", fs.existsSync(ffmpegPath));

import ffmpeg from "fluent-ffmpeg";
ffmpeg.setFfmpegPath(ffmpegPath);

const TINY_MP3_B64 =
  "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhgCenp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6e////////////////////////////////////////////////////////AAAAAExhdmM1OC41NAAAAAAAAAAAAAAAACQCkAAAAAAAA4YuZiMAAAAAAAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIADMIFHMPPCAIAkEgSBIHAcBwHAcDgOA4Dg+D4Pg+D4Pg+D4Pg4Hg+D4Pg+D4Ph8Hw+D4Pg+D8H//+D4Ph8Hg+D4Ph8H4fB8Hg+D4Ph8Hg+D4Ph8H4fBwHAcBwHA//tQxBYAC4whQGxhIAC4IFHMPPCIcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwHAcBwH";

const mp3Buffer = Buffer.from(TINY_MP3_B64, "base64");

function transcodeToMulaw8kFile(inputBuffer, inputFormat) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `kie-tts-in-${Date.now()}.mp3`);
    const outputPath = path.join(tmpDir, `kie-tts-out-${Date.now()}.raw`);

    fs.writeFileSync(inputPath, inputBuffer);

    let command = ffmpeg(inputPath);
    if (inputFormat) command = command.inputFormat(inputFormat);

    command
      .audioCodec("pcm_mulaw")
      .audioChannels(1)
      .audioFrequency(8000)
      .format("mulaw")
      .output(outputPath)
      .on("error", (err) => {
        fs.rmSync(inputPath, { force: true });
        fs.rmSync(outputPath, { force: true });
        reject(err);
      })
      .on("end", () => {
        try {
          const result = fs.readFileSync(outputPath);
          fs.rmSync(inputPath, { force: true });
          fs.rmSync(outputPath, { force: true });
          resolve(result);
        } catch (readErr) {
          reject(readErr);
        }
      })
      .run();
  });
}

console.log("\n--- Starting file-based transcode ---");
try {
  const output = await transcodeToMulaw8kFile(mp3Buffer, "mp3");
  console.log("Transcode SUCCEEDED. Output byte length:", output.length);
  const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-output-file.raw");
  fs.writeFileSync(outPath, output);
  console.log("Raw ulaw output written to:", outPath);
} catch (err) {
  console.error("Transcode FAILED:", err.message);
  console.error("Stack:", err.stack);
  process.exit(1);
}
