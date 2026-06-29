import WebSocket from "ws";

import { ApiError } from "../../utils/apiError.js";

const DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen";

function validPositiveNumber(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return null;

  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function explicitBoolean(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function buildDeepgramConfig({ fallback = false } = {}) {
  const model = fallback ? "nova-2" : process.env.DEEPGRAM_MODEL || "nova-2-phonecall";
  const encoding = "mulaw";
  const sampleRate = 8000;
  const channels = 1;
  const interimResults = true;
  const smartFormat = fallback ? null : true;
  const punctuate = true;
  const endpointing = validPositiveNumber(process.env.DEEPGRAM_ENDPOINTING_MS) || 300;
  const utteranceEndMs = fallback ? null : validPositiveNumber(process.env.DEEPGRAM_UTTERANCE_END_MS);
  const vadEvents = fallback ? null : explicitBoolean(process.env.DEEPGRAM_VAD_EVENTS);

  return {
    model,
    encoding,
    sampleRate,
    channels,
    interimResults,
    smartFormat,
    punctuate,
    endpointing,
    utteranceEndMs,
    vadEvents
  };
}

function buildDeepgramUrl(config) {
  const params = new URLSearchParams();
  params.set("model", config.model);
  params.set("encoding", config.encoding);
  params.set("sample_rate", String(config.sampleRate));
  params.set("channels", String(config.channels));
  params.set("interim_results", String(config.interimResults));
  if (config.smartFormat !== null) params.set("smart_format", String(config.smartFormat));
  params.set("punctuate", String(config.punctuate));
  if (config.endpointing !== null) params.set("endpointing", String(config.endpointing));
  if (config.utteranceEndMs !== null) params.set("utterance_end_ms", String(config.utteranceEndMs));
  if (config.vadEvents !== null) params.set("vad_events", String(config.vadEvents));

  return `${DEEPGRAM_LIVE_URL}?${params.toString()}`;
}

function logDeepgramConfig(config, urlWithoutToken, metadata) {
  console.log("[Deepgram] Live socket config", {
    ...metadata,
    model: config.model,
    encoding: config.encoding,
    sampleRate: config.sampleRate,
    channels: config.channels,
    interimResults: config.interimResults,
    smartFormat: config.smartFormat,
    punctuate: config.punctuate,
    endpointing: config.endpointing,
    utteranceEndMs: config.utteranceEndMs,
    vadEvents: config.vadEvents,
    urlWithoutToken
  });
}

function isHandshake400(error) {
  return /unexpected server response:\s*400/i.test(error?.message || "");
}

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

  const pendingAudio = [];
  let socket = null;
  let closed = false;
  let retrying = false;

  function connect(config) {
    const isFallbackAttempt = config.model === "nova-2" && config.smartFormat === null;
    let socketOpened = false;
    const urlWithoutToken = buildDeepgramUrl(config);

    logDeepgramConfig(config, urlWithoutToken, metadata);
    console.log("[Deepgram] Live socket opening", metadata);

    const currentSocket = new WebSocket(urlWithoutToken, {
      headers: {
        Authorization: `Token ${apiKey}`
      }
    });
    socket = currentSocket;

    function retryWithFallbackAfter400() {
      if (socketOpened || retrying) return;
      retrying = true;
      console.warn("[Deepgram] Retrying with minimal fallback config after 400", {
        ...metadata,
        failedConfig: config,
        failedUrlWithoutToken: urlWithoutToken
      });
      connect(buildDeepgramConfig({ fallback: true }));
    }

    currentSocket.on("open", () => {
      socketOpened = true;
      console.log("[Deepgram] Live socket opened", metadata);
      while (pendingAudio.length > 0 && currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.send(pendingAudio.shift());
      }
    });

    currentSocket.on("unexpected-response", (request, response) => {
      console.error("[Deepgram] Live socket unexpected response", {
        ...metadata,
        statusCode: response?.statusCode,
        statusMessage: response?.statusMessage,
        urlWithoutToken,
        config
      });
      if (response?.statusCode === 400) {
        retryWithFallbackAfter400();
      }
    });

    currentSocket.on("close", (code, reason) => {
      if (!socketOpened && retrying && !isFallbackAttempt) {
        return;
      }

      if (!socketOpened) {
        console.warn("[Deepgram] socket closed before open", {
          ...metadata,
          code,
          reason: reason?.toString?.() || reason || null,
          urlWithoutToken,
          config
        });
      }

      console.log("[Deepgram] Live socket closed", {
        ...metadata,
        code,
        reason: reason?.toString?.() || reason || null
      });

      if (!closed) {
        onClose?.({ code, reason, opened: socketOpened, sttFailed: !socketOpened && (isFallbackAttempt || !retrying) });
      }
    });

    currentSocket.on("message", (data) => {
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

    currentSocket.on("error", (error) => {
      console.error("[Deepgram] Live socket error", {
        ...metadata,
        message: error?.message,
        code: error?.code,
        urlWithoutToken,
        config
      });

      if (!socketOpened && isHandshake400(error)) {
        retryWithFallbackAfter400();
      }
    });
  }

  connect(buildDeepgramConfig());

  return {
    sendAudio(buffer) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(buffer);
        return;
      }
      if (socket?.readyState === WebSocket.CONNECTING) {
        pendingAudio.push(buffer);
      }
    },
    close() {
      closed = true;
      pendingAudio.length = 0;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "CloseStream" }));
      }
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  };
}
