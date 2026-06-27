// REAL Kie TTS call using the actual .env credentials.
// This reproduces the EXACT code path a phone call triggers (Deepgram transcript
// -> synthesizeSpeech -> synthesizeSpeechWithKie) WITHOUT needing a phone.
// It will reveal the real content-type Kie returns and where the failure occurs.

import "dotenv/config";

console.log("=== ENV CHECK ===");
console.log("CUSTOM_TTS_PROVIDER:", process.env.CUSTOM_TTS_PROVIDER);
console.log("KIE_TTS_ENABLED:", process.env.KIE_TTS_ENABLED);
console.log("KIE_API_KEY set:", !!process.env.KIE_API_KEY);
console.log("KIE_TTS_MODEL:", process.env.KIE_TTS_MODEL);
console.log("KIE_TTS_OUTPUT_FORMAT:", process.env.KIE_TTS_OUTPUT_FORMAT);
console.log("KIE_TTS_REQUIRE_MULAW:", process.env.KIE_TTS_REQUIRE_MULAW);
console.log("KIE_CALLBACK_URL:", process.env.KIE_CALLBACK_URL);
console.log("KIE_TTS_CALLBACK_URL:", process.env.KIE_TTS_CALLBACK_URL);
console.log("");

const { synthesizeSpeech } = await import("../src/voice/tts/index.js");

console.log("=== CALLING synthesizeSpeech (full real path) ===");
try {
  const buf = await synthesizeSpeech({ text: "Hello, this is a test of the voice system." });
  console.log("\n>>> SUCCESS. Final buffer length:", buf.length, "bytes");
  console.log(">>> First 16 bytes (hex):", buf.subarray(0, 16).toString("hex"));
} catch (err) {
  console.error("\n>>> FAILED");
  console.error(">>> code:", err?.code || err?.details?.code);
  console.error(">>> statusCode:", err?.statusCode);
  console.error(">>> message:", err?.message);
  console.error(">>> details:", JSON.stringify(err?.details, null, 2));
  console.error(">>> stack:", err?.stack);
  process.exit(1);
}
