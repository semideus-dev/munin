// The renderer-to-main boundary is small on purpose: a fixed, explicit channel
// allowlist, closed request shapes, and a strict URL trust check. These tests
// exercise the compiled main-process helpers without launching Electron.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { IPC_CHANNEL_LIST } from "../../apps/desktop/dist/shared/ipc.js";
import {
  sanitizeFindingRequest,
  sanitizeReadRequest,
  sanitizeScanRequest,
  sanitizeSessionRequest,
} from "../../apps/desktop/dist/main/requests.js";
import { isTrustedRendererUrl } from "../../apps/desktop/dist/main/security.js";

const desktopRoot = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const rendererDir = join(desktopRoot, "dist/renderer");
const rendererFile = pathToFileURL(join(rendererDir, "index.html")).href;

function rejectsInvalid(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, "request.invalid");
    assert.equal(error.kind, "usage");
    return true;
  });
}

test("the preload bridge exposes exactly the allowlisted channels", () => {
  assert.deepEqual([...IPC_CHANNEL_LIST].sort(), [
    "munin:activity",
    "munin:app-info",
    "munin:finding",
    "munin:findings",
    "munin:health",
    "munin:minimize",
    "munin:overview",
    "munin:privacy",
    "munin:scan",
    "munin:session",
    "munin:source-status",
    "munin:usage",
  ]);
  assert.equal(new Set(IPC_CHANNEL_LIST).size, IPC_CHANNEL_LIST.length);
  assert.equal(IPC_CHANNEL_LIST.some((channel) => channel === "munin:invoke"), false);
});

test("read requests accept only known, well-typed filters", () => {
  assert.deepEqual(sanitizeReadRequest(undefined), {});
  assert.deepEqual(sanitizeReadRequest(null), {});
  assert.deepEqual(sanitizeReadRequest({}), {});
  assert.deepEqual(sanitizeReadRequest({ days: 7, project: "munin", tz: "America/New_York" }), {
    days: 7,
    project: "munin",
    tz: "America/New_York",
  });

  rejectsInvalid(() => sanitizeReadRequest("nope"));
  rejectsInvalid(() => sanitizeReadRequest([1, 2]));
  rejectsInvalid(() => sanitizeReadRequest({ days: 0 }));
  rejectsInvalid(() => sanitizeReadRequest({ days: -1 }));
  rejectsInvalid(() => sanitizeReadRequest({ days: 1.5 }));
  rejectsInvalid(() => sanitizeReadRequest({ days: "7" }));
  rejectsInvalid(() => sanitizeReadRequest({ project: "   " }));
  rejectsInvalid(() => sanitizeReadRequest({ tz: "" }));
  rejectsInvalid(() => sanitizeReadRequest({ db: "/tmp/x.db" }));
  rejectsInvalid(() => sanitizeReadRequest({ stateDir: "/tmp/state" }));
});

test("finding requests require a bounded identifier and reject unknown keys", () => {
  assert.deepEqual(sanitizeFindingRequest({ rule: "oversized-tool-output", days: 14 }), {
    rule: "oversized-tool-output",
    days: 14,
  });
  rejectsInvalid(() => sanitizeFindingRequest({}));
  rejectsInvalid(() => sanitizeFindingRequest({ rule: "   " }));
  rejectsInvalid(() => sanitizeFindingRequest({ rule: 42 }));
  rejectsInvalid(() => sanitizeFindingRequest({ rule: "x".repeat(201) }));
  rejectsInvalid(() => sanitizeFindingRequest({ rule: "ok", sessions: ["ses_1"] }));
  rejectsInvalid(() => sanitizeFindingRequest({ rule: "bad\u0000rule" }));
});

test("session requests require a bounded identifier and reject unknown keys", () => {
  assert.deepEqual(sanitizeSessionRequest({ sessionId: "ses_abc123", tz: "UTC" }), {
    sessionId: "ses_abc123",
    tz: "UTC",
  });
  rejectsInvalid(() => sanitizeSessionRequest({}));
  rejectsInvalid(() => sanitizeSessionRequest({ sessionId: "" }));
  rejectsInvalid(() => sanitizeSessionRequest({ sessionId: "x".repeat(201) }));
  rejectsInvalid(() => sanitizeSessionRequest({ sessionId: "ses_1", sql: "DROP TABLE" }));
  rejectsInvalid(() => sanitizeSessionRequest({ sessionId: "ses_\u001f" }));
});

test("scan requests may only add a boolean full flag", () => {
  assert.deepEqual(sanitizeScanRequest({ days: 30, tz: "local", full: true }), {
    days: 30,
    tz: "local",
    full: true,
  });
  rejectsInvalid(() => sanitizeScanRequest({ full: "yes" }));
  rejectsInvalid(() => sanitizeScanRequest({ db: "/tmp/source.db" }));
  rejectsInvalid(() => sanitizeScanRequest({ stateDir: "/tmp/state" }));
  rejectsInvalid(() => sanitizeScanRequest({ days: 0, full: true }));
});

test("only the built renderer and the configured Vite origin are trusted", () => {
  const options = { rendererDir };

  assert.equal(isTrustedRendererUrl(rendererFile, options), true);
  assert.equal(
    isTrustedRendererUrl(pathToFileURL(join(rendererDir, "assets/app.js")).href, options),
    true,
  );
  assert.equal(
    isTrustedRendererUrl(
      pathToFileURL(join(desktopRoot, "dist/renderer-evil/index.html")).href,
      options,
    ),
    false,
    "a sibling directory that shares a prefix must not be trusted",
  );
  assert.equal(isTrustedRendererUrl("file:///etc/passwd", options), false);
  assert.equal(isTrustedRendererUrl("https://example.com/", options), false);
  assert.equal(isTrustedRendererUrl("about:blank", options), false);
  assert.equal(isTrustedRendererUrl("not a url", options), false);

  const devOptions = { rendererDir, devUrl: "http://127.0.0.1:5173" };
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5173/", devOptions), true);
  assert.equal(
    isTrustedRendererUrl("http://127.0.0.1:5173/src/renderer/main.tsx", devOptions),
    true,
  );
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5174/", devOptions), false);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5173.evil.test/", devOptions), false);
  assert.equal(isTrustedRendererUrl("https://127.0.0.1:5173/", devOptions), false);
  assert.equal(isTrustedRendererUrl(rendererFile, devOptions), true);
});
