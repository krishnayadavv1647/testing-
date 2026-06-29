import WebSocket from "ws";

import { ApiError } from "../../utils/apiError.js";

const DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen";

export function createDeepgramLiveTranscriber({
  apiKey = process.env.DEEPGRAM_API_KEY,
  onInterimTranscript,
  onFinalTranscript,
  onClose,
  metadata = {}
} = {}) {
  if (!apiKey) {
    throw new ApiError(500, "Deepgram API key is not configured.");
  }

  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-2-phonecall",
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: String(Number(process.env.DEEPGRAM_ENDPOINTING_MS || 200)),
    utterance_end_ms: String(Number(process.env.DEEPGRAM_UTTERANCE_END_MS || 700)),
    vad_events: "true"
  });

  console.log("[Deepgram] Live socket opening", metadata);

  const socket = new WebSocket(`${DEEPGRAM_LIVE_URL}?${params.toString()}`, {
    headers: {
      Authorization: `Token ${apiKey}`
    }
  });
  const pendingAudio = [];

  socket.on("open", () => {
    console.log("[Deepgram] Live socket opened", metadata);
    while (pendingAudio.length > 0 && socket.readyState === WebSocket.OPEN) {
      socket.send(pendingAudio.shift());
    }
  });

  socket.on("close", (code, reason) => {
    console.log("[Deepgram] Live socket closed", {
      ...metadata,
      code,
      reason: reason?.toString?.() || reason || null
    });
    onClose?.({ code, reason });
  });

  socket.on("message", (data) => {
    let result;
    try {
      result = JSON.parse(data.toString());
    } catch {
      return;
    }

    const transcript = result?.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) return;

    const isFinal = Boolean(result?.is_final);
    const speechFinal = Boolean(result?.speech_final);

    // Treat is_final OR speech_final as a final transcript. Pure interim results
    // (neither flag set) are surfaced separately so the caller can echo the latest
    // interim if Deepgram closes before emitting a final.
    if (!isFinal && !speechFinal) {
      if (process.env.DEBUG_STT_INTERIM === "true") {
        console.log("[Deepgram] Interim transcript", { ...metadata, transcript });
      }
      onInterimTranscript?.(transcript, result);
      return;
    }

    console.log("[Deepgram] Final transcript", { ...metadata, transcript, isFinal, speechFinal });
    onFinalTranscript?.(transcript, result);
  });

  socket.on("error", (error) => {
    console.error("[Deepgram] Live socket error", {
      ...metadata,
      message: error?.message,
      code: error?.code
    });
  });

  return {
    sendAudio(buffer) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(buffer);
        return;
      }
      if (socket.readyState === WebSocket.CONNECTING) {
        pendingAudio.push(buffer);
      }
    },
    close() {
      pendingAudio.length = 0;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "CloseStream" }));
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  };
}
