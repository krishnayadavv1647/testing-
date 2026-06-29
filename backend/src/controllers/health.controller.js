import axios from "axios";

import { synthesizeSpeech } from "../voice/tts/index.js";
import { synthesizeSpeechWithKie } from "../voice/tts/kie.js";
import { resolveLiveTtsProvider, getTtsRuntimeSummary } from "../voice/tts/provider.js";

// Module-level start time so the runtime endpoint can report uptime.
const SERVICE_STARTED_AT = new Date().toISOString();

const DEFAULT_HEALTH_TEXT = "Hello, this is a TTS health check.";
const SECRET_KEY_PATTERN = /(authorization|api[_-]?key|secret|token|password|bearer)/i;

// Recursively strip anything that looks like a secret and cap depth/size so the health
// response never leaks credentials and never dumps a giant binary/object.
function sanitizeDetails(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return "[truncated]";
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDetails(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitizeDetails(val, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…[truncated]`;
  return value;
}

/**
 * GET /api/debug/runtime — safe, unauthenticated snapshot of the running backend's config.
 * No secrets. Used to confirm which deployed instance (Render vs local) Twilio is hitting,
 * and to verify env vars are present without revealing their values.
 */
export function runtimeDebug(req, res) {
  let resolvedProvider = null;
  let providerError = null;

  try {
    resolvedProvider = resolveLiveTtsProvider();
  } catch (error) {
    providerError = error.details?.code || error.message;
  }

  res.status(200).json({
    success: true,
    service: "AI Voice Agent Backend",
    environment: process.env.NODE_ENV || null,
    startedAt: SERVICE_STARTED_AT,
    gitCommit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    publicMediaWsUrlConfigured: Boolean(process.env.PUBLIC_MEDIA_WS_URL),
    publicMediaWsUrl: process.env.PUBLIC_MEDIA_WS_URL || null,
    ttsProvider: resolvedProvider,
    ttsProviderError: providerError,
    kieEnabled: process.env.KIE_TTS_ENABLED === "true",
    hasKieApiKey: Boolean(process.env.KIE_API_KEY),
    hasDeepgramApiKey: Boolean(process.env.DEEPGRAM_API_KEY),
    callDebugTranscriptOnly: process.env.CALL_DEBUG_TRANSCRIPT_ONLY === "true",
    debugSttInterim: process.env.DEBUG_STT_INTERIM === "true"
  });
}

/**
 * GET/POST /api/health/tts — run the real live-call TTS path once and report the outcome
 * as JSON, so TTS can be validated without placing a phone call. Never returns secrets.
 * Authenticated admin-only (mounted behind protect + requireAdmin).
 */
export async function ttsHealthCheck(req, res) {
  const text = String(req.body?.text || req.query?.text || DEFAULT_HEALTH_TEXT);
  const runtime = getTtsRuntimeSummary();

  let provider;
  try {
    provider = resolveLiveTtsProvider();
  } catch (error) {
    // Provider is misconfigured (e.g. CUSTOM_TTS_PROVIDER=kie + KIE_TTS_ENABLED=false).
    return res.status(503).json({
      success: false,
      provider: null,
      bytes: 0,
      errorCode: error.details?.code || "TTS_PROVIDER_ERROR",
      errorMessage: error.message,
      statusCode: error.statusCode || 500,
      details: sanitizeDetails(error.details),
      runtime
    });
  }

  try {
    const audio = await synthesizeSpeech({ text, provider });
    return res.status(200).json({
      success: true,
      provider,
      bytes: audio.length,
      errorCode: null,
      errorMessage: null,
      statusCode: null,
      details: null,
      runtime
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      provider,
      bytes: 0,
      errorCode: error.details?.code || error.code || "TTS_SYNTH_FAILED",
      errorMessage: error.message,
      statusCode: error.statusCode || error.details?.providerStatus || null,
      details: sanitizeDetails(error.details),
      runtime
    });
  }
}

/**
 * GET /api/health/kie-credit - checks Kie account credit without exposing secrets.
 */
export async function kieCreditHealthCheck(req, res) {
  if (!process.env.KIE_API_KEY) {
    return res.status(503).json({
      success: false,
      statusCode: 500,
      errorMessage: "KIE_API_KEY is missing.",
      providerBody: null
    });
  }

  const baseUrl = String(process.env.KIE_BASE_URL || "https://api.kie.ai").replace(/\/+$/, "");

  try {
    const response = await axios.get(`${baseUrl}/api/v1/chat/credit`, {
      headers: {
        Authorization: `Bearer ${process.env.KIE_API_KEY}`,
        Accept: "application/json"
      },
      validateStatus: () => true,
      timeout: 30000
    });

    if (response.status < 200 || response.status >= 300) {
      return res.status(503).json({
        success: false,
        statusCode: response.status,
        errorMessage: response.statusText || "Kie credit check failed.",
        providerBody: sanitizeDetails(response.data)
      });
    }

    return res.status(200).json({
      success: true,
      credits: sanitizeDetails(response.data)
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      statusCode: error.response?.status || 502,
      errorMessage: error.message,
      providerBody: sanitizeDetails(error.response?.data || null)
    });
  }
}

/**
 * POST /api/health/kie-tts - proves Kie TTS standalone:
 * create task -> poll -> download -> transcode. It does not touch Twilio/Deepgram/LLMs.
 */
export async function kieTtsHealthCheck(req, res) {
  const text = String(req.body?.text || "Hello testing");

  try {
    const audio = await synthesizeSpeechWithKie({ text });
    const diagnostics = audio.kieTtsDiagnostics || {};

    return res.status(200).json({
      success: true,
      provider: "kie",
      taskId: diagnostics.taskId || null,
      recordId: diagnostics.recordId || null,
      finalState: diagnostics.finalState || "success",
      audioUrlFound: diagnostics.audioUrlFound === true,
      downloadedBytes: diagnostics.downloadedBytes || null,
      contentType: diagnostics.contentType || null,
      transcodedBytes: diagnostics.transcodedBytes || audio.length,
      twilioReady: diagnostics.twilioReady === true,
      elapsedMs: diagnostics.elapsedMs || null
    });
  } catch (error) {
    return res.status(error.statusCode || 503).json({
      success: false,
      provider: "kie",
      errorCode: error.details?.code || error.code || "KIE_TTS_FAILED",
      errorMessage: error.message,
      details: sanitizeDetails(error.details || null)
    });
  }
}
