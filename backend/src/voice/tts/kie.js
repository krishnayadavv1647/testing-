import axios from "axios";

import { ApiError } from "../../utils/apiError.js";
import { transcodeToMulaw8k } from "./audioTranscode.js";

const DEFAULT_KIE_BASE_URL = "https://api.kie.ai";
const DEFAULT_KIE_CREATE_TASK_ENDPOINT = "/api/v1/jobs/createTask";
const DEFAULT_KIE_RECORD_INFO_ENDPOINT = "/api/v1/jobs/recordInfo";
const DEFAULT_KIE_TTS_MODEL = "elevenlabs/text-to-speech-multilingual-v2";
const DEFAULT_KIE_TTS_VOICE = "Rachel";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function joinUrl(baseUrl, endpoint) {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function errorCode(error, fallback) {
  return error?.details?.code || error?.code || fallback;
}

function makeApiError(statusCode, message, details = {}) {
  const error = new ApiError(statusCode, message, details);
  if (details.code) error.code = details.code;
  return error;
}

function sanitizeProviderBody(value, depth = 0) {
  if (value == null) return value;
  if (depth > 5) return "[truncated]";
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeProviderBody(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/authorization|api[_-]?key|secret|token|password|bearer/i.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitizeProviderBody(val, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}...[truncated]`;
  return value;
}

function providerMessage(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return data.map(providerMessage).filter(Boolean).join(" ");
  if (typeof data === "object") return data.msg || data.message || data.error || data.detail || data.title || JSON.stringify(data);
  return "";
}

function kieRequestError(error, fallback = "Kie TTS request failed.", code = "KIE_TTS_FAILED") {
  if (error instanceof ApiError) return error;
  const status = error?.response?.status || error?.statusCode || 502;
  const data = error?.response?.data;
  const message = providerMessage(data) || error?.message || fallback;
  return makeApiError(status, message, {
    code,
    provider: "kie",
    providerStatus: status,
    providerBodySafe: sanitizeProviderBody(data || null)
  });
}

function normalizeKieCallbackUrl(rawUrl) {
  const callbackUrl = String(rawUrl || "").trim().replace(/^https:\/\/https:\/\//i, "https://");
  let parsed;

  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw makeApiError(500, "KIE_TTS_CALLBACK_URL or KIE_CALLBACK_URL must be a valid public HTTPS URL.", {
      code: "KIE_CALLBACK_URL_INVALID",
      provider: "kie"
    });
  }

  if (parsed.protocol !== "https:" || !parsed.hostname || callbackUrl.slice("https://".length).includes("://")) {
    throw makeApiError(500, "KIE_TTS_CALLBACK_URL or KIE_CALLBACK_URL must be a valid public HTTPS URL.", {
      code: "KIE_CALLBACK_URL_INVALID",
      provider: "kie"
    });
  }

  return callbackUrl;
}

function firstStringUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value.startsWith("http") ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstStringUrl(item);
      if (found) return found;
    }
  }
  return "";
}

function extractAudioUrlFromResult(resultJson, data) {
  return (
    firstStringUrl(resultJson?.resultUrls) ||
    firstStringUrl(resultJson?.result_urls) ||
    firstStringUrl(resultJson?.urls) ||
    firstStringUrl(resultJson?.files?.map((file) => file?.url)) ||
    firstStringUrl(resultJson?.audio?.url) ||
    firstStringUrl(resultJson?.audioUrl) ||
    firstStringUrl(resultJson?.audio_url) ||
    firstStringUrl(resultJson?.fileUrl) ||
    firstStringUrl(resultJson?.file_url) ||
    firstStringUrl(resultJson?.resultUrl) ||
    firstStringUrl(resultJson?.result_url) ||
    firstStringUrl(data?.resultUrls) ||
    firstStringUrl(data?.result_urls) ||
    firstStringUrl(data?.audioUrl) ||
    firstStringUrl(data?.audio_url) ||
    firstStringUrl(data?.resultUrl) ||
    firstStringUrl(data?.result_url) ||
    ""
  );
}

function parseKieResultJson({ taskId, recordId, data }) {
  let resultJson = data?.resultJson;

  if (typeof resultJson === "string") {
    try {
      resultJson = JSON.parse(resultJson);
    } catch (error) {
      console.error("[Kie TTS] failed to parse resultJson", {
        taskId,
        recordId,
        message: error.message,
        resultJsonPreview: resultJson.slice(0, 500)
      });
    }
  }

  return resultJson;
}

function safeResultPreview(value) {
  if (value == null) return null;
  const preview = typeof value === "string" ? value : JSON.stringify(value);
  return preview.length > 500 ? preview.slice(0, 500) : preview;
}

function attachKieDiagnostics(buffer, diagnostics) {
  Object.defineProperty(buffer, "kieTtsDiagnostics", {
    value: diagnostics,
    enumerable: false,
    configurable: true
  });
  return buffer;
}

function buildPayload({ text, voice, callBackUrl }) {
  const payload = {
    model: process.env.KIE_TTS_MODEL || DEFAULT_KIE_TTS_MODEL,
    callBackUrl,
    input: {
      text,
      voice: voice || process.env.KIE_TTS_VOICE || DEFAULT_KIE_TTS_VOICE,
      stability: Number(process.env.KIE_TTS_STABILITY || 0.5),
      similarity_boost: Number(process.env.KIE_TTS_SIMILARITY_BOOST || 0.75),
      style: Number(process.env.KIE_TTS_STYLE || 0),
      speed: Number(process.env.KIE_TTS_SPEED || 1),
      timestamps: false,
      previous_text: "",
      next_text: "",
      language_code: ""
    }
  };

  const outputFormat = process.env.KIE_TTS_OUTPUT_FORMAT?.trim();

  if (outputFormat) {
    payload.input.output_format = outputFormat;
  }

  return { payload, outputFormat };
}

async function createKieTask({ endpoint, headers, payload, outputFormat, text, timeoutMs }) {
  console.log("[Kie TTS] createTask request", {
    endpoint,
    model: payload.model,
    voice: payload.input.voice,
    textLength: text.length,
    hasCallbackUrl: Boolean(payload.callBackUrl),
    callbackUrl: payload.callBackUrl || null,
    hasOutputFormat: Boolean(outputFormat),
    outputFormat: outputFormat || null
  });

  let response;
  try {
    response = await axios.post(endpoint, payload, { headers, timeout: Math.min(timeoutMs, 30000) });
  } catch (error) {
    throw kieRequestError(error, "Kie TTS task creation failed.", "KIE_TTS_CREATE_TASK_FAILED");
  }

  const body = response.data;
  console.log("[Kie TTS CreateTask Response]", {
    code: body?.code,
    msg: body?.msg,
    taskId: body?.data?.taskId || null,
    recordId: body?.data?.recordId || null,
    dataKeys: body?.data ? Object.keys(body.data) : []
  });

  if (body?.code && body.code !== 200) {
    throw makeApiError(502, body?.msg || "Kie TTS createTask failed.", {
      code: "KIE_TTS_CREATE_TASK_FAILED",
      provider: "kie",
      providerStatus: body.code,
      providerBodySafe: sanitizeProviderBody(body)
    });
  }

  const taskId = body?.data?.taskId;
  const recordId = body?.data?.recordId || null;

  if (!taskId) {
    throw makeApiError(502, "Kie TTS createTask did not return taskId.", {
      code: "KIE_TTS_NO_TASK_ID",
      provider: "kie",
      recordId,
      providerBodySafe: sanitizeProviderBody(body)
    });
  }

  return { taskId, recordId };
}

async function pollKieTask({ baseUrl, headers, taskId, recordId, timeoutMs }) {
  const recordInfoEndpoint = process.env.KIE_RECORD_INFO_ENDPOINT || DEFAULT_KIE_RECORD_INFO_ENDPOINT;
  const recordInfoUrl = `${baseUrl}${recordInfoEndpoint}?taskId=${encodeURIComponent(taskId)}`;

  console.log("[Kie TTS] recordInfo request", {
    taskId,
    recordId,
    queryParamUsed: "taskId",
    endpoint: recordInfoEndpoint
  });

  const pollMs = Math.max(100, Number(process.env.KIE_TTS_POLL_INTERVAL_MS || 3000));
  const startedAt = Date.now();
  let lastState = null;
  let lastFailCode = null;
  let lastFailMsg = null;
  let lastProgress = null;
  let lastProviderBodySafe = null;

  while (Date.now() - startedAt < timeoutMs) {
    let response;
    try {
      response = await axios.get(recordInfoUrl, { headers, timeout: Math.min(timeoutMs, 30000) });
    } catch (error) {
      throw kieRequestError(error, "Kie TTS polling failed.", "KIE_TTS_POLL_FAILED");
    }

    const body = response.data;
    const safeBody = sanitizeProviderBody(body);
    const data = body?.data || {};
    const state = String(data?.state || data?.status || "").toLowerCase() || "unknown";
    const elapsedMs = Date.now() - startedAt;

    lastState = state;
    lastFailCode = data?.failCode || null;
    lastFailMsg = data?.failMsg || null;
    lastProgress = data?.progress || null;
    lastProviderBodySafe = safeBody;

    console.log("[Kie TTS] poll", {
      taskId,
      recordId,
      code: body?.code,
      msg: body?.msg,
      state,
      failCode: data?.failCode || null,
      failMsg: data?.failMsg || null,
      progress: data?.progress || null,
      costTime: data?.costTime || null,
      elapsedMs,
      dataKeys: data ? Object.keys(data) : []
    });

    if (state === "success") {
      return { body, data, finalState: state, elapsedMs };
    }

    if (state === "fail" || state === "failed" || state === "error") {
      throw makeApiError(502, data?.failMsg || "Kie TTS failed.", {
        code: "KIE_TTS_FAILED",
        provider: "kie",
        taskId,
        recordId,
        failCode: data?.failCode || null,
        failMsg: data?.failMsg || null,
        state,
        providerBodySafe: safeBody
      });
    }

    await sleep(pollMs);
  }

  const elapsedMs = Date.now() - startedAt;
  throw makeApiError(504, "Kie TTS task did not complete before timeout.", {
    code: "KIE_TTS_TIMEOUT",
    provider: "kie",
    taskId,
    recordId,
    lastState,
    lastFailCode,
    lastFailMsg,
    lastProgress,
    elapsedMs,
    timeoutMs,
    lastProviderBodySafe
  });
}

async function downloadKieAudio({ audioUrl, taskId, recordId }) {
  const audioUrlHost = new URL(audioUrl).host;

  console.log("[Kie TTS] downloading audio", {
    taskId,
    recordId,
    audioUrlHost
  });

  let response;
  try {
    response = await axios.get(audioUrl, {
      responseType: "arraybuffer",
      timeout: Number(process.env.KIE_TTS_DOWNLOAD_TIMEOUT_MS || 30000),
      validateStatus: () => true
    });
  } catch (error) {
    throw kieRequestError(error, "Kie TTS audio download failed.", "KIE_TTS_AUDIO_DOWNLOAD_FAILED");
  }

  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
  const contentLength = response.headers?.["content-length"] || null;

  console.log("[Kie TTS] audio download response", {
    taskId,
    recordId,
    status: response.status,
    statusText: response.statusText,
    contentType,
    contentLength
  });

  if (response.status < 200 || response.status >= 300) {
    const bodyPreview = Buffer.isBuffer(response.data)
      ? response.data.toString("utf8").slice(0, 500)
      : String(response.data || "").slice(0, 500);

    throw makeApiError(502, "Kie TTS audio download failed.", {
      code: "KIE_TTS_AUDIO_DOWNLOAD_FAILED",
      provider: "kie",
      status: response.status,
      statusText: response.statusText,
      contentType,
      bodyPreview,
      taskId,
      recordId,
      audioUrlHost
    });
  }

  const audioBuffer = Buffer.from(response.data);

  console.log("[Kie TTS] audio downloaded", {
    taskId,
    recordId,
    contentType,
    bytes: audioBuffer.length
  });

  if (!audioBuffer.length) {
    throw makeApiError(502, "Kie TTS audio download returned empty buffer.", {
      code: "KIE_TTS_EMPTY_AUDIO_BUFFER",
      provider: "kie",
      taskId,
      recordId,
      contentType,
      audioUrlHost
    });
  }

  return { audioBuffer, contentType, downloadedBytes: audioBuffer.length };
}

export async function synthesizeSpeechWithKie({ text, voice } = {}) {
  if (!process.env.KIE_API_KEY) {
    throw makeApiError(500, "KIE_API_KEY is missing.", { code: "KIE_API_KEY_MISSING", provider: "kie" });
  }
  if (!text?.trim()) throw makeApiError(400, "Text is required for speech synthesis.", { code: "KIE_TTS_TEXT_REQUIRED", provider: "kie" });

  const startedAt = Date.now();
  const cleanText = text.trim();
  const baseUrl = String(process.env.KIE_BASE_URL || DEFAULT_KIE_BASE_URL).replace(/\/+$/, "");
  const endpoint = joinUrl(baseUrl, process.env.KIE_CREATE_TASK_ENDPOINT || DEFAULT_KIE_CREATE_TASK_ENDPOINT);
  const timeoutMs = Number(process.env.KIE_TTS_TIMEOUT_MS || 60000);
  const callBackUrl = normalizeKieCallbackUrl(process.env.KIE_CALLBACK_URL || process.env.KIE_TTS_CALLBACK_URL);
  const headers = {
    Authorization: `Bearer ${process.env.KIE_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  const { payload, outputFormat } = buildPayload({ text: cleanText, voice, callBackUrl });

  const { taskId, recordId } = await createKieTask({
    endpoint,
    headers,
    payload,
    outputFormat,
    text: cleanText,
    timeoutMs
  });

  const pollResult = await pollKieTask({ baseUrl, headers, taskId, recordId, timeoutMs });
  const resultJson = parseKieResultJson({ taskId, recordId, data: pollResult.data });
  const audioUrl = extractAudioUrlFromResult(resultJson, pollResult.data);

  if (!audioUrl) {
    throw makeApiError(502, "Kie TTS succeeded but no audio URL was found.", {
      code: "KIE_TTS_NO_AUDIO_URL",
      provider: "kie",
      taskId,
      recordId,
      state: pollResult.finalState,
      dataKeys: Object.keys(pollResult.data || {}),
      resultJsonType: typeof pollResult.data?.resultJson,
      resultJsonPreview: safeResultPreview(pollResult.data?.resultJson)
    });
  }

  console.log("[Kie TTS] success", {
    taskId,
    recordId,
    audioUrlFound: true,
    elapsedMs: pollResult.elapsedMs
  });

  console.log("[Kie TTS] audio URL found", {
    taskId,
    recordId,
    audioUrlHost: new URL(audioUrl).host
  });

  const download = await downloadKieAudio({ audioUrl, taskId, recordId });
  const transcoded = await transcodeToMulaw8k(download.audioBuffer, { contentType: download.contentType });

  return attachKieDiagnostics(transcoded, {
    provider: "kie",
    taskId,
    recordId,
    finalState: pollResult.finalState,
    audioUrlFound: true,
    downloadedBytes: download.downloadedBytes,
    contentType: download.contentType,
    transcodedBytes: transcoded.length,
    twilioReady: true,
    elapsedMs: Date.now() - startedAt
  });
}

export function getKieErrorCode(error, fallback = "KIE_TTS_FAILED") {
  return errorCode(error, fallback);
}
