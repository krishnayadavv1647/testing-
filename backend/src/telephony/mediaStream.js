import WebSocket, { WebSocketServer } from "ws";

import TelephonyConfig from "../models/TelephonyConfig.js";
import { TwilioTelephony } from "./twilio.telephony.js";
import { createDeepgramLiveTranscriber } from "../voice/stt/index.js";
import { synthesizeSpeech } from "../voice/tts/index.js";

const TWILIO_MULAW_20MS_BYTES = 160;
const TTS_FAILURE_FALLBACK_MESSAGE = "We're experiencing a technical issue, please try again shortly.";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const playbackId = session.playbackId + 1;
  session.playbackId = playbackId;
  session.speaking = true;

  try {
    for (let offset = 0; offset < audioBuffer.length; offset += TWILIO_MULAW_20MS_BYTES) {
      if (session.closed || session.playbackId !== playbackId || ws.readyState !== WebSocket.OPEN) break;

      const chunk = audioBuffer.subarray(offset, offset + TWILIO_MULAW_20MS_BYTES);
      sendAudioToTwilio(ws, session.streamSid, chunk.toString("base64"));
      await delay(20);
    }
  } finally {
    if (session.playbackId === playbackId) {
      session.speaking = false;
    }
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
  closeDeepgram(session);
  session.closed = true;
  session.speaking = false;
  session.playbackId += 1;
  session.agentId = null;
  session.telephonyConfigId = null;
}

function handleStart(ws, session, message) {
  session.streamSid = message.start?.streamSid || message.streamSid;
  session.callSid = message.start?.callSid;
  session.agentId = message.start?.customParameters?.agentId;
  session.telephonyConfigId = message.start?.customParameters?.telephonyConfigId;

  try {
    session.deepgram = createDeepgramLiveTranscriber({
      onFinalTranscript: async (text) => {
        if (session.closed) return;

        console.log(`[MediaStream:${session.streamSid}] Transcript: ${text}`);

        try {
          console.log(`[MediaStream:${session.streamSid}] TTS echo requested`);
          const audio = await synthesizeSpeech({ text });
          await streamAudioBufferToTwilio(ws, session, audio);
        } catch (error) {
          console.error(`[MediaStream:${session.streamSid}] TTS echo failed`, {
            code: error?.code,
            message: error?.message,
            statusCode: error?.statusCode,
            details: error?.details,
            stack: error?.stack
          });
          console.error("[Technical Issue Fallback Triggered]", {
            code: error?.code,
            message: error?.message,
            statusCode: error?.statusCode,
            details: error?.details,
            stack: error?.stack
          });
          await playTwilioTtsFallback(ws, session, error.details?.category || error.message);
        }
      }
    });
  } catch (error) {
    console.error(`[MediaStream:${session.streamSid || "unknown"}] Failed to start Deepgram`, error.message);
    session.closed = true;
    ws.close();
  }
}

function handleMedia(ws, session, message) {
  if (session.speaking) {
    session.playbackId += 1;
    sendClearToTwilio(ws, session.streamSid);
    session.speaking = false;
  }

  const payload = message.media?.payload;
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
    handleStart(ws, session, message);
    return;
  }

  if (message.event === "media") {
    handleMedia(ws, session, message);
    return;
  }

  if (message.event === "stop") {
    cleanUpSession(session);
  }
}

export function attachMediaStreamServer(httpServer) {
  const mediaServer = new WebSocketServer({ server: httpServer, path: "/media" });

  mediaServer.on("connection", (ws) => {
    const session = {
      streamSid: null,
      callSid: null,
      agentId: null,
      telephonyConfigId: null,
      deepgram: null,
      speaking: false,
      playbackId: 0,
      fallbackTriggered: false,
      closed: false
    };

    ws.on("message", (message) => handleMessage(ws, session, message));

    ws.on("close", () => {
      cleanUpSession(session);
    });

    ws.on("error", (error) => {
      console.error(`[MediaStream:${session.streamSid || "unknown"}] WebSocket error`, error.message);
      cleanUpSession(session);
    });
  });

  console.log("[MediaStream] Twilio media WebSocket server attached at /media");
  return mediaServer;
}
