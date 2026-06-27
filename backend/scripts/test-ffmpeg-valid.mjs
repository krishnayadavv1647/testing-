// Test ffmpeg with a VALID mp3 file via fluent-ffmpeg (both pipe and file approaches)
import { createRequire } from "module";
import { PassThrough } from "stream";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");
console.log("ffmpeg path:", ffmpegPath, "exists:", fs.existsSync(ffmpegPath));

import ffmpeg from "fluent-ffmpeg";
ffmpeg.setFfmpegPath(ffmpegPath);

const validMp3 = fs.readFileSync("C:/Users/HP/AppData/Local/Temp/test-valid.mp3");
console.log("Valid MP3 size:", validMp3.length, "bytes");

// Test 1: PassThrough pipe (current production approach)
console.log("\n--- Test 1: PassThrough pipe (current production code) ---");
async function testPipe(inputBuffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const input = new PassThrough();
    input.end(inputBuffer);

    ffmpeg(input)
      .inputFormat("mp3")
      .audioCodec("pcm_mulaw")
      .audioChannels(1)
      .audioFrequency(8000)
      .format("mulaw")
      .on("error", (err) => { console.error("PIPE error:", err.message); reject(err); })
      .on("end", () => { console.log("PIPE end, chunks:", chunks.length); resolve(Buffer.concat(chunks)); })
      .pipe()
      .on("data", (chunk) => chunks.push(chunk))
      .on("error", (err) => { console.error("PIPE output error:", err.message); reject(err); });
  });
}

try {
  const r = await testPipe(validMp3);
  console.log("PIPE: SUCCEEDED, output bytes:", r.length);
} catch (err) {
  console.error("PIPE: FAILED:", err.message);
}

// Test 2: File-based approach (write input to temp file, read output temp file)
console.log("\n--- Test 2: Temp-file approach ---");
async function testFile(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const inPath = path.join(tmpDir, `tts-in-${Date.now()}.mp3`);
    const outPath = path.join(tmpDir, `tts-out-${Date.now()}.raw`);
    fs.writeFileSync(inPath, inputBuffer);

    ffmpeg(inPath)
      .inputFormat("mp3")
      .audioCodec("pcm_mulaw")
      .audioChannels(1)
      .audioFrequency(8000)
      .format("mulaw")
      .output(outPath)
      .on("error", (err) => {
        fs.rmSync(inPath, { force: true });
        fs.rmSync(outPath, { force: true });
        console.error("FILE error:", err.message);
        reject(err);
      })
      .on("end", () => {
        const result = fs.readFileSync(outPath);
        fs.rmSync(inPath, { force: true });
        fs.rmSync(outPath, { force: true });
        resolve(result);
      })
      .run();
  });
}

try {
  const r = await testFile(validMp3);
  console.log("FILE: SUCCEEDED, output bytes:", r.length);
} catch (err) {
  console.error("FILE: FAILED:", err.message);
}
