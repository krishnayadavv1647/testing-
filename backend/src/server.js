import "dotenv/config";

import app from "./app.js";
import { connectDB } from "./config/db.js";
import { startFollowUpWorker } from "./services/followUpWorker.js";
import { startCampaignWorker } from "./services/campaignWorker.js";
import { startScheduledCallWorker } from "./services/scheduledCallWorker.js";
import { startEmailSyncWorker } from "./workers/emailSyncWorker.js";
import { startTelegramBot } from "./services/telegram/bot.js";
import { startPipelineScheduler } from "./services/pipelineScheduler.js";
import { refreshPlanConfig } from "./config/plans.js";
import { refreshCreditPricing } from "./config/creditPricing.js";
import { attachMediaStreamServer } from "./telephony/mediaStream.js";
import { runElevenLabsStartupHealthCheck } from "./services/voiceProviders/elevenLabsDiagnostics.js";
import { runTtsStartupDiagnostics } from "./voice/tts/startupDiagnostics.js";

const PORT = process.env.PORT || 5000;

connectDB()
  .then(async () => {
    console.log("Database connected");
    await Promise.all([refreshPlanConfig(), refreshCreditPricing()]);
    const server = app.listen(PORT, () => {
      console.log(`AI Voice Agent API running on port ${PORT}`);
    });
    attachMediaStreamServer(server);

    // Log a secret-free TTS runtime summary and surface any misconfiguration loudly,
    // so a broken live-call TTS path is diagnosable from logs without placing a phone call.
    const ttsRuntime = runTtsStartupDiagnostics();
    if (ttsRuntime.provider === "elevenlabs") {
      runElevenLabsStartupHealthCheck().catch((error) => {
        console.warn("[ElevenLabs] Startup health check failed unexpectedly", error.message);
      });
    } else {
      console.log("[TTS] Using Kie for custom TTS; skipping direct ElevenLabs startup health check.");
    }

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`Backend port ${PORT} is already in use. Another backend server is probably already running.`);
        process.exit(1);
      }

      console.error("Backend server failed to start", error.message);
      process.exit(1);
    });

    startScheduledCallWorker();
    startCampaignWorker();
    startFollowUpWorker();
    startEmailSyncWorker();
    startTelegramBot();
    startPipelineScheduler();
  })
  .catch((error) => {
    console.error("Database connection failed", error.message);
    process.exit(1);
  });
