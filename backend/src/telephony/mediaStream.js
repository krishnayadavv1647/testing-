import WebSocket, { WebSocketServer } from "ws";

import TelephonyConfig from "../models/TelephonyConfig.js";
import { TwilioTelephony } from "./twilio.telephony.js";
import { createDeepgramLiveTranscriber } from "../voice/stt/index.js";
import { synthesizeSpeech } from "../voice/tts/index.js";
import { getTtsRuntimeSummary } from "../voice/tts/provider.js";

const TWILIO_MULAW_CHUNK_SIZE = 160;
const TWILIO_CHUNK_DELAY_MS = 20;
const TTS_FAILURE_FALLBACK_MESSAGE = "We're experiencing a technical issue, please try again shortly.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Provider response bodies (e.g. Kie's job result) carry no secrets, but can be large.
// Cap the serialized size so a failure log stays readable.
function safeProviderBody(body) {
  if (body == null) return null;
  try {
    const json = JSON.stringify(body);
    return json.length > 2000 ? `${json.slice(0, 2000)}…[truncated]` : body;
  } catch {
    return "[unserializable provider body]";
  }
}

function sendClearToTwilio(ws, streamSid) {
  if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ event: "clear", streamSid }));
}

export function sendAudioToTwilio(ws, streamSid, base64Payload) {
  if (!streamSid || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    event: "media",
    streamSid,
    media: {
      payload: base64Payload
    }
  }));
}

async function streamAudioBufferToTwilio(ws, session, audioBuffer) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    console.warn("[Twilio Outbound Audio] empty or invalid audio buffer", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      isBuffer: Buffer.isBuffer(audioBuffer),
      audioBytes: audioBuffer?.length || 0
    });
    return;
  }

  const expectedChunks = Math.ceil(audioBuffer.length / TWILIO_MULAW_CHUNK_SIZE);

  console.log("[Twilio Outbound Audio] stream requested", {
    streamSid: session.streamSid,
    callSid: session.callSid,
    wsReadyState: ws.readyState,
    audioBytes: audioBuffer.length,
    chunkSize: TWILIO_MULAW_CHUNK_SIZE,
    expectedChunks
  });

  if (ws.readyState !== 1) {
    console.warn("[Twilio Outbound Audio] cannot stream because WebSocket is not open", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      readyState: ws.readyState
    });
    return;
  }

  let chunksSent = 0;

  for (let offset = 0; offset < audioBuffer.length; offset += TWILIO_MULAW_CHUNK_SIZE) {
    if (ws.readyState !== 1) {
      console.warn("[Twilio Outbound Audio] WebSocket closed during stream", {
        streamSid: session.streamSid,
        callSid: session.callSid,
        offset,
        chunksSent,
        readyState: ws.readyState
      });
      break;
    }

    const chunk = audioBuffer.subarray(
      offset,
      Math.min(offset + TWILIO_MULAW_CHUNK_SIZE, audioBuffer.length)
    );

    ws.send(JSON.stringify({
      event: "media",
      streamSid: session.streamSid,
      media: {
        payload: chunk.toString("base64")
      }
    }));

    chunksSent += 1;

    if (chunksSent === 1 || chunksSent % 20 === 0 || chunksSent === expectedChunks) {
      console.log("[Twilio Outbound Audio] chunk sent", {
        streamSid: session.streamSid,
        callSid: session.callSid,
        chunksSent,
        expectedChunks,
        chunkBytes: chunk.length
      });
    }

    await sleep(TWILIO_CHUNK_DELAY_MS);
  }

  const markName = `echo-${Date.now()}`;

  if (ws.readyState === 1) {
    ws.send(JSON.stringify({
      event: "mark",
      streamSid: session.streamSid,
      mark: {
        name: markName
      }
    }));
  }

  console.log("[Twilio Outbound Audio] stream completed", {
    streamSid: session.streamSid,
    callSid: session.callSid,
    audioBytes: audioBuffer.length,
    chunksSent,
    expectedChunks,
    markName,
    wsReadyState: ws.readyState
  });
}

// Echo the caller's words back via TTS. Shared by the final-transcript, interim-debounce,
// and interim-on-close paths. Never calls an LLM/agent — it only repeats `rawText`.
// `source` identifies which path triggered the echo (final | interim_debounce | interim_on_close).
async function echoTranscript(ws, session, rawText, source = "final") {
  const transcript = rawText?.trim();
  if (!transcript) return;

  if (process.env.CALL_DEBUG_TRANSCRIPT_ONLY === "true") {
    console.log("[EchoBot] Transcript-only mode enabled; skipping TTS echo.", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      source,
      text: transcript
    });
    return;
  }

  const customAiMode = (process.env.CUSTOM_AI_MODE || "echo").toLowerCase();
  if (customAiMode !== "echo") {
    console.log("[EchoBot] Skipped because CUSTOM_AI_MODE is not echo", {
      customAiMode,
      streamSid: session.streamSid,
      source,
      text: transcript
    });
    return;
  }

  if (!session.twilioWsOpen || ws.readyState !== WebSocket.OPEN) {
    console.warn("[EchoBot] Cannot echo because Twilio WebSocket is not open", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      readyState: ws.readyState,
      source,
      text: transcript
    });
    return;
  }

  if (session.echoInProgress) {
    console.log("[EchoBot] Echo already in progress; skipping duplicate/new transcript", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      text: transcript
    });
    return;
  }

  // Dedupe: the same text can arrive as a debounced interim AND a final (or twice from
  // Deepgram). Don't echo identical text again within 5s.
  const now = Date.now();
  if (
    session.lastEchoedTranscript === transcript &&
    now - session.lastEchoedAt < 5000
  ) {
    console.log("[EchoBot] Duplicate transcript skipped", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      source,
      text: transcript
    });
    return;
  }

  session.echoInProgress = true;
  session.lastEchoedTranscript = transcript;
  session.lastEchoedAt = now;

  try {
    session.transcriptCount = (session.transcriptCount || 0) + 1;

    console.log("[Caller Transcript]", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      agentId: session.agentId,
      telephonyConfigId: session.telephonyConfigId,
      transcriptCount: session.transcriptCount,
      source,
      text: transcript
    });

    console.log("[EchoBot] Repeating caller transcript", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      source,
      provider: process.env.CUSTOM_TTS_PROVIDER || null,
      textLength: transcript.length,
      text: transcript
    });

    const ttsStartedAt = Date.now();
    const audio = await synthesizeSpeech({ text: transcript });

    console.log("[EchoBot] TTS success", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      provider: process.env.CUSTOM_TTS_PROVIDER || null,
      bytes: audio?.length || 0,
      elapsedMs: Date.now() - ttsStartedAt
    });

    if (!session.twilioWsOpen || ws.readyState !== WebSocket.OPEN) {
      console.warn("[EchoBot] TTS completed but Twilio WebSocket is already closed", {
        streamSid: session.streamSid,
        callSid: session.callSid,
        readyState: ws.readyState,
        elapsedMs: Date.now() - ttsStartedAt
      });
      return;
    }

    console.log("[EchoBot] Streaming TTS audio to caller", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      bytes: audio?.length || 0,
      wsReadyState: ws.readyState
    });

    await streamAudioBufferToTwilio(ws, session, audio);

    console.log("[EchoBot] Audio streamed back to caller", {
      streamSid: session.streamSid,
      callSid: session.callSid
    });
  } catch (error) {
    // Echo failure is non-fatal: log the real error, keep the call open, do NOT play
    // a generic fallback and do NOT hang up the WebSocket.
    console.error("[EchoBot] Echo TTS/audio stream failed", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      source,
      provider: process.env.CUSTOM_TTS_PROVIDER || null,
      code: error?.details?.code || error?.code,
      message: error?.message,
      statusCode: error?.statusCode,
      details: error?.details,
      stack: error?.stack
    });
  } finally {
    session.echoInProgress = false;
  }
}

function closeDeepgram(session) {
  if (!session.deepgram) return;

  try {
    session.deepgram.close();
  } catch (error) {
    console.error(`[MediaStream:${session.streamSid || "unknown"}] Failed to close Deepgram`, error.message);
  } finally {
    session.deepgram = null;
  }
}

async function playTwilioTtsFallback(ws, session, reason) {
  if (session.fallbackTriggered) return;
  session.fallbackTriggered = true;
  session.playbackId += 1;
  session.speaking = false;
  sendClearToTwilio(ws, session.streamSid);

  if (!session.callSid || !session.telephonyConfigId) {
    console.error(`[MediaStream:${session.streamSid || "unknown"}] Cannot play Twilio fallback; missing callSid or telephonyConfigId`, {
      callSid: session.callSid || null,
      telephonyConfigId: session.telephonyConfigId || null,
      reason
    });
    ws.close();
    return;
  }

  try {
    const config = await TelephonyConfig.findById(session.telephonyConfigId);
    if (!config || config.provider !== "twilio") {
      console.error(`[MediaStream:${session.streamSid || "unknown"}] Cannot play Twilio fallback; telephony config is unavailable or not Twilio`, {
        telephonyConfigId: session.telephonyConfigId,
        provider: config?.provider || null,
        reason
      });
      ws.close();
      return;
    }

    await TwilioTelephony.playFallbackAndHangup(config, {
      callSid: session.callSid,
      message: TTS_FAILURE_FALLBACK_MESSAGE
    });
    console.warn(`[MediaStream:${session.streamSid}] Twilio fallback <Say> issued after TTS failure`, {
      callSid: session.callSid,
      reason
    });
  } catch (error) {
    console.error(`[MediaStream:${session.streamSid || "unknown"}] Failed to issue Twilio fallback <Say>`, {
      message: error.message,
      statusCode: error.statusCode,
      details: error.details
    });
    ws.close();
  }
}

function cleanUpSession(session) {
  if (session.interimEchoTimer) {
    clearTimeout(session.interimEchoTimer);
    session.interimEchoTimer = null;
  }
  closeDeepgram(session);
  session.closed = true;
  session.speaking = false;
  session.playbackId += 1;
  session.agentId = null;
  session.telephonyConfigId = null;
}

async function handleStart(ws, session, message) {
  session.streamSid = message.start?.streamSid || message.streamSid;
  session.callSid = message.start?.callSid;
  session.agentId = message.start?.customParameters?.agentId;
  session.telephonyConfigId = message.start?.customParameters?.telephonyConfigId;

  console.log("[MediaStream] Twilio WS start", {
    streamSid: session.streamSid,
    callSid: session.callSid,
    agentId: session.agentId,
    telephonyConfigId: session.telephonyConfigId
  });

  try {
    session.deepgram = createDeepgramLiveTranscriber({
      metadata: {
        streamSid: session.streamSid,
        callSid: session.callSid,
        agentId: session.agentId,
        telephonyConfigId: session.telephonyConfigId
      },

      onInterimTranscript: (text) => {
        const transcript = text?.trim();
        if (!transcript) return;

        session.latestInterimTranscript = transcript;
        session.latestInterimAt = Date.now();

        console.log("[EchoBot] Stored interim transcript", {
          streamSid: session.streamSid,
          callSid: session.callSid,
          text: transcript
        });

        // Debounce: if Deepgram never sends a final transcript, echo the latest interim
        // after a short pause in speech. Each new interim resets the timer.
        if (session.interimEchoTimer) {
          clearTimeout(session.interimEchoTimer);
        }

        const delayMs = Number(process.env.ECHO_INTERIM_AFTER_MS || 700);
        session.interimEchoTimer = setTimeout(() => {
          const latest = session.latestInterimTranscript?.trim();
          if (!latest) return;

          echoTranscript(ws, session, latest, "interim_debounce").catch((error) => {
            console.error("[EchoBot] Interim debounce echo failed", {
              streamSid: session.streamSid,
              callSid: session.callSid,
              message: error?.message,
              code: error?.code,
              stack: error?.stack
            });
          });
        }, delayMs);
      },

      onFinalTranscript: async (text) => {
        // A real final arrived — cancel any pending interim-debounce echo for this utterance.
        if (session.interimEchoTimer) {
          clearTimeout(session.interimEchoTimer);
          session.interimEchoTimer = null;
        }
        await echoTranscript(ws, session, text, "final");
      },

      onClose: async (event = {}) => {
        if (event.sttFailed) {
          console.error("[EchoBot] Cannot echo because Deepgram STT connection failed.", {
            streamSid: session.streamSid,
            callSid: session.callSid,
            latestInterimTranscript: session.latestInterimTranscript || null
          });
          return;
        }

        // Deepgram closed (e.g. code 1005) before emitting a final transcript. As a last
        // resort, echo the latest interim so the caller still hears their words repeated.
        if (process.env.ECHO_INTERIM_ON_CLOSE === "true") {
          const latest = session.latestInterimTranscript;
          if (latest) {
            console.log("[EchoBot] Deepgram closed before final transcript. Echoing latest interim transcript.", {
              streamSid: session.streamSid,
              callSid: session.callSid,
              text: latest
            });
            await echoTranscript(ws, session, latest, "interim_on_close");
          }
        } else {
          console.log("[EchoBot] Deepgram closed; not echoing on close because ECHO_INTERIM_ON_CLOSE is false", {
            streamSid: session.streamSid,
            callSid: session.callSid,
            latestInterimTranscript: session.latestInterimTranscript || null
          });
        }
      }
    });
  } catch (error) {
    console.error(`[MediaStream:${session.streamSid || "unknown"}] Failed to start Deepgram`, {
      message: error.message,
      code: error?.code,
      stack: error?.stack
    });
    session.closed = true;
    ws.close();
    return;
  }

  // NOTE: The initial greeting is spoken by Twilio's native <Say> in the TwiML (see
  // twilio.telephony.js custom_ai branch), BEFORE this media stream connects. We intentionally
  // do NOT synthesize the greeting via Kie/ElevenLabs here, so a broken custom TTS provider
  // can never make the call silent on pickup.
}

function handleMedia(ws, session, message) {
  session.mediaFrameCount = (session.mediaFrameCount || 0) + 1;
  const payload = message.media?.payload;

  if (
    process.env.DEBUG_TWILIO_MEDIA_EVENTS === "true" &&
    (session.mediaFrameCount === 1 || session.mediaFrameCount % 1000 === 0)
  ) {
    console.log(`[MediaStream:${session.streamSid}] Twilio media frames received`, {
      count: session.mediaFrameCount,
      hasPayload: Boolean(payload),
      payloadLength: payload?.length || 0,
      hasDeepgram: Boolean(session.deepgram),
      callSid: session.callSid
    });
  }

  if (!payload || !session.deepgram) return;

  session.deepgram.sendAudio(Buffer.from(payload, "base64"));
}

function handleMessage(ws, session, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch (error) {
    console.error("[MediaStream] Ignoring invalid JSON frame", error.message);
    return;
  }

  if (message.event === "start") {
    // handleStart is async; fire-and-forget with a top-level catch so one bad call
    // cannot crash the WebSocket server.
    handleStart(ws, session, message).catch((error) => {
      console.error(`[MediaStream:${session.streamSid || "unknown"}] handleStart failed`, {
        message: error?.message,
        code: error?.code,
        statusCode: error?.statusCode,
        stack: error?.stack
      });
    });
    return;
  }

  if (message.event === "media") {
    handleMedia(ws, session, message);
    return;
  }

  if (message.event === "mark") {
    console.log("[Twilio Outbound Audio] mark received", {
      streamSid: session.streamSid,
      callSid: session.callSid,
      mark: message.mark
    });
    return;
  }

  if (message.event === "stop") {
    cleanUpSession(session);
  }
}

export function attachMediaStreamServer(httpServer) {
  const mediaServer = new WebSocketServer({ server: httpServer, path: "/media" });

  mediaServer.on("connection", (ws, req) => {
    console.log("[MediaStream] Twilio WebSocket connected", {
      url: req?.url,
      remoteAddress: req?.socket?.remoteAddress,
      userAgent: req?.headers?.["user-agent"]
    });

    const session = {
      streamSid: null,
      callSid: null,
      agentId: null,
      telephonyConfigId: null,
      deepgram: null,
      speaking: false,
      playbackId: 0,
      fallbackTriggered: false,
      closed: false,
      mediaFrameCount: 0,
      transcriptCount: 0,
      latestInterimTranscript: null,
      latestInterimAt: 0,
      interimEchoTimer: null,
      lastEchoedTranscript: null,
      lastEchoedAt: 0,
      echoInProgress: false,
      twilioWsOpen: true
    };

    ws.on("message", (message) => handleMessage(ws, session, message));

    ws.on("close", (code, reason) => {
      session.twilioWsOpen = false;
      console.log(`[MediaStream:${session.streamSid || "unknown"}] WebSocket closed`, {
        code,
        reason: reason?.toString() || null,
        callSid: session.callSid,
        mediaFrameCount: session.mediaFrameCount,
        transcriptCount: session.transcriptCount
      });
      cleanUpSession(session);
    });

    ws.on("error", (error) => {
      session.twilioWsOpen = false;
      console.error(`[MediaStream:${session.streamSid || "unknown"}] WebSocket error`, {
        message: error?.message,
        stack: error?.stack
      });
      cleanUpSession(session);
    });
  });

  console.log("[MediaStream] Twilio media WebSocket server attached at /media");
  return mediaServer;
}
