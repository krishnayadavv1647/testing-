import WebSocket from "ws";

import { ApiError } from "../../utils/apiError.js";

const DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen";

export function createDeepgramLiveTranscriber({
  apiKey = process.env.DEEPGRAM_API_KEY,
  onFinalTranscript,
  metadata = {}
} = {}) {
  if (!apiKey) {
    throw new ApiError(500, "Deepgram API key is not configured.");
  }

  const params = new URLSearchParams({
    encoding: "mulaw",
    sample_rate: "8000",
    interim_results: "true",
    endpointing: "300",
    smart_format: "true"
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
      reason: reason?.toString() || null
    });
  });

  socket.on("message", (data) => {
    let result;
    try {
      result = JSON.parse(data.toString());
    } catch {
      return;
    }

    const transcript = result.channel?.alternatives?.[0]?.transcript?.trim();

    if (result.is_final && transcript) {
      console.log("[Deepgram] Final transcript", { ...metadata, transcript });
      onFinalTranscript?.(transcript);
    } else if (process.env.DEBUG_STT_INTERIM === "true" && transcript) {
      console.log("[Deepgram] Interim transcript", { ...metadata, transcript });
    }
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
