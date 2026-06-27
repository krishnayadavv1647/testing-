import { synthesizeSpeech } from "../voice/tts/index.js";
import { resolveLiveTtsProvider, getTtsRuntimeSummary } from "../voice/tts/provider.js";

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
