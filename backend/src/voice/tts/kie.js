import axios from "axios";

import { ApiError } from "../../utils/apiError.js";
import { getFfmpegStatus, inputFormatFromContentType, transcodeToMulaw8k } from "./audioTranscode.js";

const DEFAULT_KIE_BASE_URL = "https://api.kie.ai";
const DEFAULT_KIE_CREATE_TASK_ENDPOINT = "/api/v1/jobs/createTask";
const DEFAULT_KIE_RECORD_INFO_ENDPOINT = "/api/v1/jobs/recordInfo";
const DEFAULT_KIE_TTS_MODEL = "elevenlabs/text-to-speech-multilingual-v2";
const DEFAULT_KIE_TTS_VOICE = "Rachel";

function joinUrl(baseUrl, endpoint) {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function providerMessage(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return data.map(providerMessage).filter(Boolean).join(" ");
  if (typeof data === "object") return data.msg || data.message || data.error || data.detail || data.title || JSON.stringify(data);
  return "";
}

function parseJsonValue(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstAudioUrl(task = {}) {
  const result = parseJsonValue(task.resultJson) || task.resultJson || task.result || task.output || task.response;
  if (!result) return "";
  if (typeof result === "string") return result.startsWith("http") ? result : "";
  if (Array.isArray(result)) return result.find((item) => typeof item === "string" && item.startsWith("http")) || "";
  return (
    result.audioUrl ||
    result.audio_url ||
    result.url ||
    result.fileUrl ||
    result.file_url ||
    result.resultUrl ||
    result.result_url ||
    result.resultUrls?.[0] ||
    result.result_urls?.[0] ||
    result.urls?.[0] ||
    result.files?.[0]?.url ||
    result.audio?.url ||
    ""
  );
}

function kieTtsError(error, fallback = "Kie TTS request failed.") {
  if (error instanceof ApiError) return error;
  const status = error?.response?.status || error?.statusCode || 502;
  const data = error?.response?.data;
  const message = providerMessage(data) || error?.message || fallback;
  return new ApiError(status, `Kie TTS failed: ${message}`, {
    code: "KIE_TTS_FAILED",
    provider: "kie",
    providerStatus: status,
    providerBody: data || null
  });
}

function normalizeKieCallbackUrl(rawUrl) {
  const callbackUrl = String(rawUrl || "").trim().replace(/^https:\/\/https:\/\//i, "https://");
  let parsed;

  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new ApiError(500, "KIE_TTS_CALLBACK_URL or KIE_CALLBACK_URL must be a valid public HTTPS URL.", {
      code: "KIE_CALLBACK_URL_INVALID",
      provider: "kie"
    });
  }

  if (parsed.protocol !== "https:" || !parsed.hostname || callbackUrl.slice("https://".length).includes("://")) {
    throw new ApiError(500, "KIE_TTS_CALLBACK_URL or KIE_CALLBACK_URL must be a valid public HTTPS URL.", {
      code: "KIE_CALLBACK_URL_INVALID",
      provider: "kie"
    });
  }

  return callbackUrl;
}

function buildKieTtsInput({ text, voice }) {
  const input = {
    text,
    voice: voice || process.env.KIE_TTS_VOICE || DEFAULT_KIE_TTS_VOICE,
    stability: Number(process.env.KIE_TTS_STABILITY || 0.5),
    similarity_boost: Number(process.env.KIE_TTS_SIMILARITY_BOOST || 0.75),
    style: Number(process.env.KIE_TTS_STYLE || 0),
    speed: Number(process.env.KIE_TTS_SPEED || 1),
    timestamps: false,
    previous_text: "",
    next_text: "",
    language_code: process.env.KIE_TTS_LANGUAGE_CODE || ""
  };

  // Only send output_format when explicitly configured and non-empty. Kie's ElevenLabs
  // TTS models do not reliably honor it (they return audio/mpeg regardless), so leaving it
  // unset avoids sending a parameter the provider may reject — we transcode to ulaw downstream.
  const outputFormat = String(process.env.KIE_TTS_OUTPUT_FORMAT || "").trim();
  if (outputFormat) {
    input.output_format = outputFormat;
  }

  return input;
}

async function waitForKieTtsTask({ baseUrl, headers, taskId, timeout }) {
  const pollMs = Math.max(1000, Number(process.env.KIE_TTS_POLL_INTERVAL_MS || 1500));
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    let response;
    try {
      response = await axios.get(joinUrl(baseUrl, process.env.KIE_RECORD_INFO_ENDPOINT || DEFAULT_KIE_RECORD_INFO_ENDPOINT), {
        headers,
        params: { taskId },
        timeout: Math.min(timeout, 30000)
      });
    } catch (error) {
      throw kieTtsError(error, "Kie TTS polling failed.");
    }

    if (response.data?.code && response.data.code !== 200 && response.data.code !== 505) {
      throw new ApiError(502, `Kie TTS failed: ${response.data.msg || "Task polling failed."}`, {
        code: "KIE_TTS_FAILED",
        provider: "kie",
        taskId,
        providerStatus: response.data.code,
        providerBody: response.data
      });
    }

    const task = response.data?.data || response.data || {};
    const state = String(task.state || task.status || "").toLowerCase();
    console.log("[Kie TTS] poll", { taskId, state: state || "unknown", elapsedMs: Date.now() - startedAt });

    if (state === "success") return task;
    if (state === "fail" || state === "failed" || state === "error") {
      throw new ApiError(502, task.failMsg || task.failure || task.failReason || "Kie TTS task failed.", {
        code: "KIE_TTS_FAILED",
        provider: "kie",
        taskId,
        state,
        providerBody: task
      });
    }
    // In-progress states (waiting, queuing, queued, generating, processing, running, pending)
    // and any unrecognized state fall through and keep polling until success/fail/timeout.

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new ApiError(504, "Kie TTS timed out.", {
    code: "KIE_TTS_TIMEOUT",
    provider: "kie",
    taskId
  });
}

export async function synthesizeSpeechWithKie({ text, voice } = {}) {
  if (!process.env.KIE_API_KEY) {
    throw new ApiError(500, "KIE_API_KEY is missing.", { code: "KIE_API_KEY_MISSING", provider: "kie" });
  }
  if (!text?.trim()) throw new ApiError(400, "Text is required for speech synthesis.");

  const baseUrl = String(process.env.KIE_BASE_URL || DEFAULT_KIE_BASE_URL).replace(/\/+$/, "");
  const endpoint = joinUrl(baseUrl, process.env.KIE_CREATE_TASK_ENDPOINT || DEFAULT_KIE_CREATE_TASK_ENDPOINT);
  const model = String(process.env.KIE_TTS_MODEL || DEFAULT_KIE_TTS_MODEL).trim();
  const timeout = Number(process.env.KIE_TTS_TIMEOUT_MS || 45000);
  const callBackUrl = normalizeKieCallbackUrl(process.env.KIE_TTS_CALLBACK_URL || process.env.KIE_CALLBACK_URL);
  // The API key lives only in the Authorization header, never in the payload, so logging the
  // payload below is safe.
  const headers = {
    Authorization: `Bearer ${process.env.KIE_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  const payload = {
    model,
    callBackUrl,
    input: buildKieTtsInput({ text, voice })
  };

  console.log("[Kie TTS] createTask request", {
    endpoint,
    model,
    voice: payload.input.voice,
    textLength: text.length,
    outputFormat: payload.input.output_format || "(unset — transcode downstream)"
  });

  let taskResponse;
  try {
    taskResponse = await axios.post(endpoint, payload, { headers, timeout: Math.min(timeout, 30000) });
    console.log("[Kie TTS CreateTask Response]", taskResponse.data);
  } catch (error) {
    console.error("[Kie TTS Error]", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      payloadWithoutSecret: payload
    });
    throw kieTtsError(error, "Kie TTS task creation failed.");
  }

  if (taskResponse.data?.code && taskResponse.data.code !== 200) {
    console.error("[Kie TTS Error]", {
      status: 200,
      data: taskResponse.data,
      message: taskResponse.data.msg || "Task creation failed.",
      payloadWithoutSecret: payload
    });
    throw new ApiError(502, `Kie TTS failed: ${taskResponse.data.msg || "Task creation failed."}`, {
      code: "KIE_TTS_FAILED",
      provider: "kie",
      providerStatus: taskResponse.data.code,
      taskId: taskResponse.data?.data?.taskId || null,
      recordId: taskResponse.data?.data?.recordId || null,
      providerBody: taskResponse.data
    });
  }

  const taskId = taskResponse.data?.data?.taskId || taskResponse.data?.taskId;
  if (!taskId) {
    throw new ApiError(502, "Kie TTS did not return a task ID.", {
      code: "KIE_TTS_NO_TASK_ID",
      provider: "kie",
      providerBody: taskResponse.data
    });
  }

  const task = await waitForKieTtsTask({ baseUrl, headers, taskId, timeout });
  const audioUrl = firstAudioUrl(task);
  if (!audioUrl) {
    // Task reported success but we couldn't locate an audio URL in any known result shape.
    // Log the full (secret-free) task body so the actual response structure is visible.
    console.error("[Kie TTS] success but no audio URL found in result", { taskId, task });
    throw new ApiError(502, "Kie TTS returned no audio URL.", {
      code: "KIE_TTS_NO_AUDIO",
      provider: "kie",
      taskId,
      providerBody: task
    });
  }

  let audioResponse;
  try {
    audioResponse = await axios.get(audioUrl, {
      responseType: "arraybuffer",
      timeout: Number(process.env.KIE_TTS_DOWNLOAD_TIMEOUT_MS || 30000)
    });
  } catch (error) {
    throw kieTtsError(error, "Kie TTS audio download failed.");
  }

  const contentType = String(audioResponse.headers["content-type"] || "").toLowerCase();
  const audioBuffer = Buffer.from(audioResponse.data);
  console.log("[Kie TTS] response received", {
    taskId,
    contentType: contentType || "unknown",
    bytes: audioBuffer.length
  });

  if (process.env.KIE_TTS_REQUIRE_MULAW !== "false") {
    const inputFormat = inputFormatFromContentType(contentType);

    // When Kie was asked for ulaw_8000 output (KIE_TTS_OUTPUT_FORMAT=ulaw_8000) it returns
    // raw μ-law audio, typically with content-type audio/basic. That is exactly what Twilio
    // expects — transcoding is unnecessary and would fail because raw μ-law has no file header
    // for ffmpeg to auto-detect. Short-circuit here when we can confirm the audio is already
    // in the correct format.
    if (inputFormat === "mulaw") {
      console.log("[Kie TTS] audio is already μ-law 8kHz, skipping transcode", {
        taskId,
        contentType: contentType || "unknown",
        bytes: audioBuffer.length
      });
      return audioBuffer;
    }

    console.log("[Kie TTS] starting transcode to ulaw_8000", {
      taskId,
      contentType: contentType || "unknown",
      inputFormat: inputFormat || "auto (unknown content-type)",
      inputBytes: audioBuffer.length
    });

    try {
      const transcoded = await transcodeToMulaw8k(audioBuffer, { contentType, inputFormat });
      console.log("[Kie TTS] transcode complete", {
        taskId,
        outputFormat: "ulaw_8000",
        outputBytes: transcoded.length
      });
      return transcoded;
    } catch (error) {
      console.error("[Kie TTS] TRANSCODE FAILED", {
        taskId,
        ffmpeg: getFfmpegStatus(),
        contentType: contentType || "unknown",
        inputFormat: inputFormat || "auto",
        inputBytes: audioBuffer.length,
        errorCode: error.details?.code || null,
        message: error.message,
        stack: error.stack
      });
      throw new ApiError(502, `Kie TTS audio transcoding failed: ${error.message}`, {
        code: "KIE_TTS_TRANSCODE_FAILED",
        provider: "kie",
        taskId,
        contentType,
        inputFormat,
        expectedFormat: "ulaw_8000"
      });
    }
  }

  console.log("[Kie TTS] success (transcode skipped via KIE_TTS_REQUIRE_MULAW=false)", {
    taskId,
    model,
    voice: payload.input.voice,
    contentType: contentType || "unknown",
    bytes: audioBuffer.length
  });

  return audioBuffer;
}
