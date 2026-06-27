import test from "node:test";
import assert from "node:assert/strict";

import { resolveLiveTtsProvider, getTtsRuntimeSummary } from "../src/voice/tts/provider.js";

test("CUSTOM_TTS_PROVIDER=kie with KIE_TTS_ENABLED=false throws a config conflict", () => {
  assert.throws(
    () => resolveLiveTtsProvider({ CUSTOM_TTS_PROVIDER: "kie", KIE_TTS_ENABLED: "false" }),
    (error) => {
      assert.equal(error.details?.code, "TTS_PROVIDER_CONFIG_CONFLICT");
      assert.match(error.message, /KIE_TTS_ENABLED=false/);
      return true;
    }
  );
});

test("CUSTOM_TTS_PROVIDER=elevenlabs resolves to elevenlabs regardless of KIE flag", () => {
  assert.equal(resolveLiveTtsProvider({ CUSTOM_TTS_PROVIDER: "elevenlabs", KIE_TTS_ENABLED: "true" }), "elevenlabs");
  assert.equal(resolveLiveTtsProvider({ CUSTOM_TTS_PROVIDER: "ElevenLabs " }), "elevenlabs");
});

test("no CUSTOM_TTS_PROVIDER + KIE_TTS_ENABLED=true resolves to kie", () => {
  assert.equal(resolveLiveTtsProvider({ KIE_TTS_ENABLED: "true" }), "kie");
});

test("no CUSTOM_TTS_PROVIDER + KIE disabled resolves to elevenlabs", () => {
  assert.equal(resolveLiveTtsProvider({}), "elevenlabs");
  assert.equal(resolveLiveTtsProvider({ KIE_TTS_ENABLED: "false" }), "elevenlabs");
});

test("CUSTOM_TTS_PROVIDER=kie + KIE_TTS_ENABLED=true resolves to kie", () => {
  assert.equal(resolveLiveTtsProvider({ CUSTOM_TTS_PROVIDER: "kie", KIE_TTS_ENABLED: "true" }), "kie");
});

test("unsupported CUSTOM_TTS_PROVIDER throws TTS_PROVIDER_UNSUPPORTED", () => {
  assert.throws(
    () => resolveLiveTtsProvider({ CUSTOM_TTS_PROVIDER: "openai" }),
    (error) => error.details?.code === "TTS_PROVIDER_UNSUPPORTED"
  );
});

test("getTtsRuntimeSummary never throws and captures the conflict as providerError", () => {
  const summary = getTtsRuntimeSummary({ CUSTOM_TTS_PROVIDER: "kie", KIE_TTS_ENABLED: "false", KIE_API_KEY: "x" });
  assert.equal(summary.provider, null);
  assert.equal(summary.providerError.code, "TTS_PROVIDER_CONFIG_CONFLICT");
  assert.equal(summary.hasKieApiKey, true);
  assert.equal(summary.hasDeepgramApiKey, false);
});
