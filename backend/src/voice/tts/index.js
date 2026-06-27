import axios from "axios";

import { ApiError } from "../../utils/apiError.js";
import { ELEVENLABS_TTS_URL, logElevenLabsApiError } from "../../services/voiceProviders/elevenLabsDiagnostics.js";
import { synthesizeSpeechWithKie } from "./kie.js";
import { resolveLiveTtsProvider } from "./provider.js";

function responseBody(error) {
  if (Buffer.isBuffer(error.response?.data)) return error.response.data.toString("utf8");
  if (error.response?.data && typeof error.response.data === "object") return JSON.stringify(error.response.data);
  return String(error.response?.data || "");
}

function isElevenLabsPermissionError(status, body) {
  return (status === 401 || status === 403) && /permission|forbidden|unauthori[sz]ed|scope/i.test(body);
}

export async function synthesizeSpeech({
  text,
  apiKey = process.env.ELEVENLABS_API_KEY,
  voiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID,
  provider
} = {}) {
  // Resolve provider via the single source of truth unless an explicit override is passed
  // (e.g. the TTS health endpoint). Misconfiguration throws here with a clear code instead
  // of silently defaulting.
  const resolvedProvider = provider || resolveLiveTtsProvider();

  if (resolvedProvider === "kie") {
    return synthesizeSpeechWithKie({ text, voice: process.env.KIE_TTS_VOICE });
  }

  if (!apiKey) {
    throw new ApiError(500, "ElevenLabs API key is not configured.");
  }
  if (!voiceId) {
    throw new ApiError(500, "ElevenLabs default voice ID is not configured.");
  }
  if (!text?.trim()) {
    throw new ApiError(400, "Text is required for speech synthesis.");
  }

  try {
    const response = await axios.post(
      `${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}?output_format=ulaw_8000`,
      {
        text,
        model_id: "eleven_multilingual_v2"
      },
      {
        responseType: "arraybuffer",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey
        }
      }
    );

    return Buffer.from(response.data);
  } catch (error) {
    const details = logElevenLabsApiError("live-call TTS generation", error, {
      voiceId,
      outputFormat: "ulaw_8000"
    });
    const status = error.response?.status || 502;
    const body = responseBody(error);

    if (isElevenLabsPermissionError(status, body)) {
      console.error("[TTS Permission Error] ElevenLabs API key lacks required permissions", {
        status,
        body,
        voiceId,
        requiredPermissions: ["voices_read", "text_to_speech"]
      });
      throw new ApiError(
        status,
        "ElevenLabs API key lacks required permissions (voices_read / text_to_speech).",
        { ...details, requiredPermissions: ["voices_read", "text_to_speech"] }
      );
    }

    console.error("[TTS Error] ElevenLabs TTS request failed", {
      status,
      body: body || null,
      voiceId,
      category: details.category,
      message: error.message
    });
    throw new ApiError(status, `ElevenLabs TTS request failed (${details.category}) with status ${status}: ${body || error.message}`, details);
  }
}
