import fs from "fs";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";

import { ApiError } from "../../utils/apiError.js";

// Startup diagnostic: logged once when this module loads so the deploy environment
// (e.g. Render Linux) immediately reveals whether the ffmpeg-static binary actually
// resolved, exists on disk, and is executable. ffmpeg-static downloads a platform-specific
// binary at npm install time; if that step was skipped or the binary lacks execute
// permission, every transcode fails and surfaces as the "technical issue" voice fallback.
const ffmpegBinaryExists = Boolean(ffmpegPath) && fs.existsSync(ffmpegPath);

let ffmpegExecutable = false;
if (ffmpegBinaryExists) {
  try {
    fs.accessSync(ffmpegPath, fs.constants.X_OK);
    ffmpegExecutable = true;
  } catch {
    ffmpegExecutable = false;
  }
}

console.log("[audioTranscode] ffmpeg-static path:", ffmpegPath || "(null)", "exists:", ffmpegBinaryExists, "executable:", ffmpegExecutable);
if (!ffmpegBinaryExists || !ffmpegExecutable) {
  console.error("[audioTranscode] ffmpeg binary missing or not executable — MP3->ulaw transcoding will fail.", {
    path: ffmpegPath || null,
    exists: ffmpegBinaryExists,
    executable: ffmpegExecutable
  });
}

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

/** Secret-free ffmpeg availability snapshot for diagnostics/health endpoints. */
export function getFfmpegStatus() {
  return { path: ffmpegPath || null, exists: ffmpegBinaryExists, executable: ffmpegExecutable };
}

/**
 * Throw a clear, distinct error when ffmpeg cannot run, so a missing binary is never
 * mistaken for a Kie/provider failure.
 * @throws {ApiError} code FFMPEG_MISSING_OR_NOT_EXECUTABLE
 */
export function assertFfmpegAvailable() {
  if (!ffmpegBinaryExists || !ffmpegExecutable) {
    throw new ApiError(500, `ffmpeg binary is missing or not executable at ${ffmpegPath || "(unresolved)"}.`, {
      code: "FFMPEG_MISSING_OR_NOT_EXECUTABLE",
      path: ffmpegPath || null,
      exists: ffmpegBinaryExists,
      executable: ffmpegExecutable
    });
  }
}

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
    try {
      assertFfmpegAvailable();
    } catch (error) {
      reject(error);
      return;
    }

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
