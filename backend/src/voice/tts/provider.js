import { ApiError } from "../../utils/apiError.js";

// Single source of truth for live-call TTS provider selection.
// CUSTOM_TTS_PROVIDER is authoritative. KIE_TTS_ENABLED is a safety interlock so the
// two can never silently disagree: if you ask for Kie but Kie is disabled, that is a
// configuration error we surface loudly instead of letting the live call fail into the
// generic "technical issue" fallback.

export const SUPPORTED_TTS_PROVIDERS = ["kie", "elevenlabs"];

export const TTS_PROVIDER_CONFLICT_MESSAGE =
  "CUSTOM_TTS_PROVIDER=kie but KIE_TTS_ENABLED=false. Enable Kie (set KIE_TTS_ENABLED=true) or set CUSTOM_TTS_PROVIDER=elevenlabs.";

function isKieEnabled(env) {
  return String(env.KIE_TTS_ENABLED || "").trim().toLowerCase() === "true";
}

/**
 * Resolve the live-call TTS provider from environment.
 * - Normalizes CUSTOM_TTS_PROVIDER (case/whitespace).
 * - Missing CUSTOM_TTS_PROVIDER -> "kie" only when KIE_TTS_ENABLED=true, else "elevenlabs".
 * - CUSTOM_TTS_PROVIDER=kie + KIE_TTS_ENABLED=false -> throws TTS_PROVIDER_CONFIG_CONFLICT.
 * - Unsupported value -> throws TTS_PROVIDER_UNSUPPORTED.
 * @throws {ApiError} on misconfiguration so the reason is logged, never hidden.
 */
export function resolveLiveTtsProvider(env = process.env) {
  const raw = String(env.CUSTOM_TTS_PROVIDER || "").trim().toLowerCase();
  const kieEnabled = isKieEnabled(env);

  if (!raw) {
    return kieEnabled ? "kie" : "elevenlabs";
  }

  if (!SUPPORTED_TTS_PROVIDERS.includes(raw)) {
    throw new ApiError(500, `Unsupported CUSTOM_TTS_PROVIDER="${env.CUSTOM_TTS_PROVIDER}". Supported values: ${SUPPORTED_TTS_PROVIDERS.join(", ")}.`, {
      code: "TTS_PROVIDER_UNSUPPORTED",
      customTtsProvider: env.CUSTOM_TTS_PROVIDER || null
    });
  }

  if (raw === "kie" && !kieEnabled) {
    throw new ApiError(500, TTS_PROVIDER_CONFLICT_MESSAGE, {
      code: "TTS_PROVIDER_CONFIG_CONFLICT",
      customTtsProvider: raw,
      kieTtsEnabled: false
    });
  }

  return raw;
}

function has(value) {
  return Boolean(value && String(value).trim());
}

/**
 * Build a secret-free snapshot of the TTS runtime for diagnostics/health.
 * Never returns key values — only booleans for presence.
 */
export function getTtsRuntimeSummary(env = process.env) {
  let provider = null;
  let providerError = null;

  try {
    provider = resolveLiveTtsProvider(env);
  } catch (error) {
    providerError = {
      code: error.details?.code || "TTS_PROVIDER_ERROR",
      message: error.message
    };
  }

  return {
    provider,
    providerError,
    customTtsProvider: env.CUSTOM_TTS_PROVIDER || null,
    kieTtsEnabled: isKieEnabled(env),
    hasKieApiKey: has(env.KIE_API_KEY),
    hasKieCallbackUrl: has(env.KIE_CALLBACK_URL) || has(env.KIE_TTS_CALLBACK_URL),
    hasElevenLabsApiKey: has(env.ELEVENLABS_API_KEY),
    hasElevenLabsVoiceId: has(env.ELEVENLABS_DEFAULT_VOICE_ID),
    hasDeepgramApiKey: has(env.DEEPGRAM_API_KEY),
    hasPublicMediaWsUrl: has(env.PUBLIC_MEDIA_WS_URL)
  };
}
