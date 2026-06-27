import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import axios from "axios";
import ffmpegPath from "ffmpeg-static";

import { synthesizeSpeechWithKie } from "../src/voice/tts/kie.js";
import { getFfmpegStatus } from "../src/voice/tts/audioTranscode.js";

const VALID_CALLBACK = "https://example.com/api/kie/callback";

// Establish a known-good Kie env so each test starts from a passing baseline and only the
// thing under test varies. Polling resolves on the first success poll, so timeouts never bite.
function setKieEnv() {
  process.env.KIE_API_KEY = "test-key";
  process.env.KIE_CALLBACK_URL = VALID_CALLBACK;
  delete process.env.KIE_TTS_CALLBACK_URL;
  delete process.env.KIE_TTS_OUTPUT_FORMAT;
  delete process.env.KIE_TTS_REQUIRE_MULAW;
  process.env.KIE_TTS_POLL_INTERVAL_MS = "1000";
  process.env.KIE_TTS_TIMEOUT_MS = "8000";
}

function recordInfoResponse(taskData) {
  return { data: { code: 200, data: { taskId: taskData.taskId || "T", state: "success", ...taskData } } };
}

function makeValidMp3() {
  // Generate a real, valid MP3 (short sine tone) so the transcode path runs end-to-end.
  return execFileSync(
    ffmpegPath,
    ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-ac", "1", "-ar", "44100", "-f", "mp3", "pipe:1"],
    { maxBuffer: 10 * 1024 * 1024 }
  );
}

test("missing KIE_API_KEY throws KIE_API_KEY_MISSING", async () => {
  const prev = process.env.KIE_API_KEY;
  delete process.env.KIE_API_KEY;
  try {
    await assert.rejects(
      () => synthesizeSpeechWithKie({ text: "hello" }),
      (error) => error.details?.code === "KIE_API_KEY_MISSING"
    );
  } finally {
    if (prev !== undefined) process.env.KIE_API_KEY = prev;
  }
});

test("invalid KIE_CALLBACK_URL throws KIE_CALLBACK_URL_INVALID before any network call", async (t) => {
  setKieEnv();
  process.env.KIE_CALLBACK_URL = "ftp://not-https";
  const post = t.mock.method(axios, "post", async () => {
    throw new Error("network should not be reached");
  });
  await assert.rejects(
    () => synthesizeSpeechWithKie({ text: "hello" }),
    (error) => error.details?.code === "KIE_CALLBACK_URL_INVALID"
  );
  assert.equal(post.mock.callCount(), 0);
});

test("createTask returning no taskId throws KIE_TTS_NO_TASK_ID", async (t) => {
  setKieEnv();
  t.mock.method(axios, "post", async () => ({ data: { code: 200, msg: "success", data: {} } }));
  await assert.rejects(
    () => synthesizeSpeechWithKie({ text: "hello" }),
    (error) => error.details?.code === "KIE_TTS_NO_TASK_ID"
  );
});

test("task success with no audio URL throws KIE_TTS_NO_AUDIO", async (t) => {
  setKieEnv();
  t.mock.method(axios, "post", async () => ({ data: { code: 200, data: { taskId: "T1" } } }));
  t.mock.method(axios, "get", async (url) => {
    assert.match(String(url), /recordInfo/);
    return recordInfoResponse({ taskId: "T1", resultJson: JSON.stringify({}) });
  });
  await assert.rejects(
    () => synthesizeSpeechWithKie({ text: "hello" }),
    (error) => error.details?.code === "KIE_TTS_NO_AUDIO"
  );
});

test("waiting task past timeout throws KIE_TTS_TIMEOUT with last state details", async (t) => {
  setKieEnv();
  process.env.KIE_TTS_TIMEOUT_MS = "1";
  process.env.KIE_TTS_POLL_INTERVAL_MS = "100";
  t.mock.method(axios, "post", async () => ({ data: { code: 200, data: { taskId: "T_TIMEOUT" } } }));
  t.mock.method(axios, "get", async (url) => {
    assert.match(String(url), /recordInfo/);
    return { data: { code: 200, data: { taskId: "T_TIMEOUT", state: "waiting" } } };
  });

  await assert.rejects(
    () => synthesizeSpeechWithKie({ text: "hello" }),
    (error) => {
      assert.equal(error.details?.code, "KIE_TTS_TIMEOUT");
      assert.equal(error.message, "Kie TTS task did not complete before timeout.");
      assert.equal(error.details?.taskId, "T_TIMEOUT");
      assert.equal(error.details?.lastState, "waiting");
      assert.equal(error.details?.timeoutMs, 1);
      assert.ok(error.details?.elapsedMs >= 1);
      return true;
    }
  );
});

test("audio/basic (raw mulaw) content skips transcode and returns the raw buffer", async (t) => {
  setKieEnv();
  const raw = Buffer.from([0xff, 0xfe, 0x7f, 0x00, 0x80, 0x12]);
  t.mock.method(axios, "post", async () => ({ data: { code: 200, data: { taskId: "T2" } } }));
  t.mock.method(axios, "get", async (url) => {
    if (String(url).includes("recordInfo")) {
      return recordInfoResponse({ taskId: "T2", resultJson: JSON.stringify({ resultUrls: ["https://cdn.example.com/a.ulaw"] }) });
    }
    return { data: raw, headers: { "content-type": "audio/basic" } };
  });
  const out = await synthesizeSpeechWithKie({ text: "hello" });
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, raw); // identical bytes => transcode was skipped
});

test("audio/mpeg (MP3) content triggers transcode to ulaw_8000", { skip: getFfmpegStatus().executable ? false : "ffmpeg not executable" }, async (t) => {
  setKieEnv();
  const mp3 = makeValidMp3();
  t.mock.method(axios, "post", async () => ({ data: { code: 200, data: { taskId: "T3" } } }));
  t.mock.method(axios, "get", async (url) => {
    if (String(url).includes("recordInfo")) {
      return recordInfoResponse({ taskId: "T3", resultJson: JSON.stringify({ resultUrls: ["https://cdn.example.com/a.mp3"] }) });
    }
    return { data: mp3, headers: { "content-type": "audio/mpeg" } };
  });
  const out = await synthesizeSpeechWithKie({ text: "hello" });
  assert.ok(Buffer.isBuffer(out));
  assert.ok(out.length > 0, "transcoded ulaw output should be non-empty");
  assert.notDeepEqual(out, mp3, "output should differ from the MP3 input (it was transcoded)");
});
