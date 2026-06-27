import fs from "fs";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";

// Startup diagnostic: logged once when this module loads so the deploy environment
// (e.g. Render Linux) immediately reveals whether the ffmpeg-static binary actually
// resolved and exists on disk. ffmpeg-static downloads a platform-specific binary at
// npm install time; if that step was skipped or the binary lacks execute permission,
// every transcode silently fails and surfaces as the "technical issue" voice fallback.
const ffmpegBinaryExists = Boolean(ffmpegPath) && fs.existsSync(ffmpegPath);
console.log("[audioTranscode] ffmpeg-static path:", ffmpegPath || "(null)", "exists:", ffmpegBinaryExists);
if (!ffmpegBinaryExists) {
  console.error("[audioTranscode] ffmpeg binary missing or unresolved — MP3->ulaw transcoding will fail.");
}

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

export function inputFormatFromContentType(contentType = "") {
  const clean = String(contentType || "").toLowerCase();
  if (clean.includes("mpeg") || clean.includes("mp3")) return "mp3";
  if (clean.includes("wav") || clean.includes("wave")) return "wav";
  if (clean.includes("ogg")) return "ogg";
  if (clean.includes("webm")) return "webm";
  if (clean.includes("mp4") || clean.includes("m4a")) return "mp4";
  // audio/basic is the IANA MIME type for raw 8-bit μ-law PCM at 8kHz (what ElevenLabs/Kie
  // returns when output_format=ulaw_8000 is requested). Without this, ffmpeg auto-detects
  // raw μ-law as rawvideo and produces an "no audio stream" error.
  if (clean.includes("mulaw") || clean.includes("ulaw") || clean === "audio/basic") return "mulaw";
  return "";
}

export function transcodeToMulaw8k(inputBuffer, { contentType = "", inputFormat } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const input = new PassThrough();
    const resolvedInputFormat = inputFormat || inputFormatFromContentType(contentType);

    input.end(inputBuffer);

    let command = ffmpeg(input);
    if (resolvedInputFormat) command = command.inputFormat(resolvedInputFormat);

    command
      .audioCodec("pcm_mulaw")
      .audioChannels(1)
      .audioFrequency(8000)
      .format("mulaw")
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks)))
      .pipe()
      .on("data", (chunk) => chunks.push(chunk))
      .on("error", reject);
  });
}
