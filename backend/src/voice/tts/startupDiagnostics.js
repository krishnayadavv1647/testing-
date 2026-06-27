import { getTtsRuntimeSummary } from "./provider.js";
import { getFfmpegStatus } from "./audioTranscode.js";

function isPublicHttpsUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:" || !parsed.hostname) return false;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Log a secret-free TTS runtime summary at startup and emit explicit warnings/errors for
 * any misconfiguration that would otherwise only surface as the live-call "technical issue"
 * fallback. Never logs secret values. Does not exit the process — other subsystems
 * (billing, email, campaigns) should keep running even if TTS is misconfigured.
 * @returns {object} the runtime summary (for tests / callers that want it)
 */
export function runTtsStartupDiagnostics(env = process.env) {
  const summary = getTtsRuntimeSummary(env);
  const ffmpeg = getFfmpegStatus();

  console.log("[TTS Runtime]", {
    provider: summary.provider,
    customTtsProvider: summary.customTtsProvider,
    kieTtsEnabled: summary.kieTtsEnabled,
    hasKieApiKey: summary.hasKieApiKey,
    hasKieCallbackUrl: summary.hasKieCallbackUrl,
    hasElevenLabsApiKey: summary.hasElevenLabsApiKey,
    hasElevenLabsVoiceId: summary.hasElevenLabsVoiceId,
    hasDeepgramApiKey: summary.hasDeepgramApiKey,
    hasPublicMediaWsUrl: summary.hasPublicMediaWsUrl,
    ffmpeg
  });

  if (summary.providerError) {
    console.error("[TTS Runtime] Provider selection error:", summary.providerError.code, "-", summary.providerError.message);
  }

  if (summary.provider === "kie") {
    if (!summary.hasKieApiKey) {
      console.error("[TTS Runtime] Kie is selected but KIE_API_KEY is missing. Live-call TTS will fail.");
    }
    const callbackUrl = env.KIE_TTS_CALLBACK_URL || env.KIE_CALLBACK_URL || "";
    if (!callbackUrl) {
      console.error("[TTS Runtime] Kie is selected but KIE_CALLBACK_URL / KIE_TTS_CALLBACK_URL is missing.");
    } else if (!isPublicHttpsUrl(callbackUrl)) {
      console.error("[TTS Runtime] Kie callback URL is not a public HTTPS URL:", callbackUrl);
    }
    if (!ffmpeg.exists || !ffmpeg.executable) {
      console.error("[TTS Runtime] Kie returns MP3 which requires ffmpeg transcoding to ulaw_8000, but ffmpeg is missing or not executable:", ffmpeg);
    }
  }

  if (summary.provider === "elevenlabs") {
    if (!summary.hasElevenLabsApiKey) {
      console.error("[TTS Runtime] ElevenLabs is selected but ELEVENLABS_API_KEY is missing. Live-call TTS will fail.");
    }
    if (!summary.hasElevenLabsVoiceId) {
      console.error("[TTS Runtime] ElevenLabs is selected but ELEVENLABS_DEFAULT_VOICE_ID is missing. Live-call TTS will fail.");
    }
  }

  // Live calls cannot reach TTS at all without Deepgram STT, so flag it loudly.
  if (!summary.hasDeepgramApiKey) {
    console.error("[TTS Runtime] DEEPGRAM_API_KEY is missing — live calls cannot transcribe speech (STT), so TTS is never invoked.");
  }
  if (!summary.hasPublicMediaWsUrl) {
    console.error("[TTS Runtime] PUBLIC_MEDIA_WS_URL is missing — Twilio cannot open the media stream WebSocket for live calls.");
  }

  return summary;
}
