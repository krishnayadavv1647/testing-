import express from "express";

import { ttsHealthCheck } from "../controllers/health.controller.js";
import { protect, requireAdmin } from "../middleware/auth.middleware.js";

const router = express.Router();

// Admin-only TTS health check: validates the live-call TTS path without a phone call.
// GET  /api/health/tts            -> uses default text (or ?text=...)
// POST /api/health/tts { text }   -> uses provided text
router.get("/tts", protect, requireAdmin, ttsHealthCheck);
router.post("/tts", protect, requireAdmin, ttsHealthCheck);

export default router;
