import express from "express";

import { kieCreditHealthCheck, kieTtsHealthCheck, ttsHealthCheck } from "../controllers/health.controller.js";
import { protect, requireAdmin } from "../middleware/auth.middleware.js";

const router = express.Router();

// Kie-only standalone checks. These never call Twilio, Deepgram, OpenAI, or an agent runtime.
router.get("/kie-credit", kieCreditHealthCheck);
router.post("/kie-tts", kieTtsHealthCheck);

// Admin-only TTS health check: validates the live-call TTS path without a phone call.
// GET  /api/health/tts            -> uses default text (or ?text=...)
// POST /api/health/tts { text }   -> uses provided text
router.get("/tts", protect, requireAdmin, ttsHealthCheck);
router.post("/tts", protect, requireAdmin, ttsHealthCheck);

export default router;
