import axios from "axios";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_TTS_URL = `${ELEVENLABS_BASE_URL}/v1/text-to-speech`;

function safeBody(data) {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (data && typeof data === "object") return JSON.stringify(data);
  return String(data || "");
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return "missing_or_invalid_permissions";
  if (status === 402) return "insufficient_credits";
  if (status === 404) return "invalid_voice_or_model";
  if (status === 422) return "invalid_request";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_server_error";
  return "request_failed";
}

export function elevenLabsErrorDetails(error) {
  const status = error?.response?.status || null;
  const body = safeBody(error?.response?.data);
  return {
    status,
    category: status ? classifyStatus(status) : "network_or_client_error",
    responseBody: body || null,
    message: error?.message || "ElevenLabs request failed",
    code: error?.code || null
  };
}

export function logElevenLabsApiError(action, error, context = {}) {
  const details = elevenLabsErrorDetails(error);
  console.error(`[ElevenLabs] ${action} failed`, {
    ...context,
    ...details
  });
  return details;
}

export async function runElevenLabsStartupHealthCheck({
  apiKey = process.env.ELEVENLABS_API_KEY,
  voiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID
} = {}) {
  if (!apiKey) {
    console.warn("[ElevenLabs] Startup health check skipped: ELEVENLABS_API_KEY is not configured.");
    return { configured: false, voicesRead: false, textToSpeech: false };
  }

  const headers = { "xi-api-key": apiKey, "Content-Type": "application/json" };
  const result = { configured: true, voicesRead: false, textToSpeech: false };

  try {
    await axios.get(`${ELEVENLABS_BASE_URL}/v2/voices`, {
      headers,
      params: { page_size: 1, include_total_count: false },
      timeout: 15000
    });
    result.voicesRead = true;
  } catch (error) {
    const details = logElevenLabsApiError("startup voices_read permission check", error);
    console.warn(`[ElevenLabs] Startup warning: voices_read check failed (${details.category}).`);
  }

  if (!voiceId) {
    console.warn("[ElevenLabs] Startup warning: ELEVENLABS_DEFAULT_VOICE_ID is not configured; text_to_speech check skipped.");
    return result;
  }

  try {
    await axios.post(
      `${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}`,
      {
        text: "Health check.",
        model_id: "eleven_flash_v2_5"
      },
      {
        headers,
        params: { output_format: "mp3_44100_128" },
        responseType: "arraybuffer",
        timeout: 15000
      }
    );
    result.textToSpeech = true;
  } catch (error) {
    const details = logElevenLabsApiError("startup text_to_speech permission check", error, {
      voiceId
    });
    console.warn(`[ElevenLabs] Startup warning: text_to_speech check failed (${details.category}).`);
  }

  if (result.voicesRead && result.textToSpeech) {
    console.log("[ElevenLabs] Startup health check passed: voices_read and text_to_speech are available.");
  }

  return result;
}
