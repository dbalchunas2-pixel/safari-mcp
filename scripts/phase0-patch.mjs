#!/usr/bin/env node
// Phase 0 patch script - makes surgical edits to safari.js, transport.js, package.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

let changes = [];
function patch(file, oldText, newText, desc) {
  const filePath = join(repoRoot, file);
  let content = readFileSync(filePath, 'utf8');
  if (!content.includes(oldText)) {
    console.error(`FAIL [${desc}]: oldText not found in ${file}`);
    process.exit(1);
  }
  if (content.includes(newText) && oldText !== newText) {
    console.log(`SKIP [${desc}]: already patched in ${file}`);
    return;
  }
  content = content.replace(oldText, newText);
  writeFileSync(filePath, content, 'utf8');
  console.log(`OK   [${desc}]: patched ${file}`);
  changes.push(desc);
}

// === safari.js ===

// 1. Add import for as-guard.js
patch('safari.js',
  'import { allowUserTabs } from "./ownership-state.js";',
  'import { allowUserTabs } from "./ownership-state.js";\nimport { asHealth, setProbeFn, incrementKillCount, probeSafari } from "./as-guard.js";',
  'safari.js: import as-guard');

// 2. Add AS_TIMEOUT_MS constant
patch('safari.js',
  'const __dirname = dirname(fileURLToPath(import.meta.url));',
  'const __dirname = dirname(fileURLToPath(import.meta.url));\nconst AS_TIMEOUT_MS = parseInt(process.env.SAFARI_MCP_AS_TIMEOUT_MS || "20000", 10);',
  'safari.js: AS_TIMEOUT_MS constant');

// 3. Modify _withHelperLock to add queue tracking + budget + probe
patch('safari.js',
  `let _helperLock = Promise.resolve();
function _withHelperLock(makePromise) {
  const result = _helperLock.then(makePromise, makePromise);
  _helperLock = result.then(() => {}, () => {});
  return result;
}`,
  `let _helperLock = Promise.resolve();
let _helperQueueDepth = 0;
function _withHelperLock(makePromise) {
  _helperQueueDepth++;
  asHealth.queueDepth = _helperQueueDepth;
  const queuedAt = Date.now();
  const run = async () => {
    _helperQueueDepth--;
    asHealth.queueDepth = _helperQueueDepth;
    const queueWait = Date.now() - queuedAt;
    if (queueWait > AS_TIMEOUT_MS) {
      throw new Error(\`AppleScript queue wait exceeded budget (waited \${queueWait}ms, budget \${AS_TIMEOUT_MS}ms)\`);
    }
    // Post-kill probe: if Safari was marked unresponsive, probe before accepting
    if (asHealth.safariUnresponsive) {
      const probeOk = await probeSafari();
      if (!probeOk) throw new Error("safari unresponsive");
      asHealth.safariUnresponsive = false;
    }
    asHealth.inflight++;
    try {
      return await makePromise();
    } finally {
      asHealth.inflight--;
    }
  };
  const result = _helperLock.then(run, run);
  _helperLock = result.then(() => {}, () => {});
  return result;
}`,
  'safari.js: _withHelperLock queue+probe');

// 4. Add Safari probe function after startHelper()
patch('safari.js',
  `startHelper();

// ========== AUTO-RESTART: recover from helper crashes ==========`,
  `startHelper();

// ========== SAFARI RESPONSIVENESS PROBE ==========
// Used by as-guard.js after a killed AppleScript call. Uses osascript subprocess
// (NOT osascriptFast) because the helper may have just been SIGKILLed.
async function _safariProbe() {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", 'tell application "Safari" to get name of document 1'], {
      timeout: 3000,
      maxBuffer: 1024,
      killSignal: "SIGKILL",
    });
    return !!stdout.trim();
  } catch {
    return false;
  }
}
setProbeFn(_safariProbe);

// ========== AUTO-RESTART: recover from helper crashes ==========`,
  'safari.js: Safari probe function');

// 5. Change osascript() default timeout
patch('safari.js',
  'async function osascript(script, { timeout = 10000 } = {}) {',
  'async function osascript(script, { timeout = AS_TIMEOUT_MS } = {}) {',
  'safari.js: osascript default timeout');

// 6. Add killSignal + health tracking to osascript's execFileAsync
patch('safari.js',
  `    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();`,
  `    const _asStart = Date.now();
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: "SIGKILL",
    });
    asHealth.lastAsDurationMs = Date.now() - _asStart;
    return stdout.trim();`,
  'safari.js: osascript killSignal SIGKILL');

// 7. Add killSignal to retry execFileAsync
patch('safari.js',
  '        const { stdout } = await execFileAsync("osascript", ["-e", retryScript], { timeout, maxBuffer: 10 * 1024 * 1024 });',
  '        const { stdout } = await execFileAsync("osascript", ["-e", retryScript], { timeout, maxBuffer: 10 * 1024 * 1024, killSignal: "SIGKILL" });',
  'safari.js: osascript retry killSignal');

// 8. Add kill tracking in osascript() catch block
patch('safari.js',
  '    throw new Error(`AppleScript error: ${err.stderr || err.message}`);',
  '    if (err.killed || err.signal === "SIGKILL") incrementKillCount();\n    throw new Error(`AppleScript error: ${err.stderr || err.message}`);',
  'safari.js: osascript kill tracking');

// 9. Change osascriptFast() default timeout
patch('safari.js',
  'async function osascriptFast(script, { timeout = 10000, noFocusGuard = false } = {}) {',
  'async function osascriptFast(script, { timeout = AS_TIMEOUT_MS, noFocusGuard = false } = {}) {',
  'safari.js: osascriptFast default timeout');

// 10. Modify _osascriptFastHelper() timeout handler to SIGKILL on first timeout
patch('safari.js',
  `      // DON'T remove from queue — replace with a proof-of-life consumer to maintain
      // FIFO order. A heavy page (e.g. the Airtable SPA) makes \`do JavaScript\` legitimately
      // slow: the call exceeds \`timeout\`ms, but the helper IS alive and emits its response a
      // moment later. That late response proves liveness — so when it arrives we reset the
      // consecutive-timeout counter instead of discarding the signal. Killing the daemon on a
      // slow page is pointless (the fresh daemon hits the same slow page) and disruptive.
      // Only a helper that NEVER replies (truly hung) accumulates timeouts with no late reply.
      const idx = _helperQueue.indexOf(cb);
      if (idx >= 0) _helperQueue[idx] = () => { _helperConsecutiveTimeouts = 0; }; // late reply ⇒ alive
      _helperConsecutiveTimeouts++;
      if (_helperConsecutiveTimeouts >= 5) {
        console.error(\`[Safari MCP] safari-helper: \${_helperConsecutiveTimeouts} consecutive timeouts with no late replies — killing daemon\`);
        _helperProc?.kill();
        _helperProc = null;
        _helperConsecutiveTimeouts = 0;
        // The killed proc's 'exit' handler also schedules a restart; guard the timer so only
        // one respawn wins (startHelper is now idempotent too) — no second, orphaned daemon.
        setTimeout(() => { if (!_shuttingDown &&  _helperProc) startHelper(); }, 100);
      }
      reject(new Error("safari-helper timeout"));`,
  `      // SIGKILL the helper on timeout — the only trustworthy cancellation (known bug 1).
      // A slow page will cause a kill+restart, but leaving a stuck helper blocks ALL
      // subsequent requests (known bug 2). The post-kill probe verifies Safari responsiveness.
      const idx = _helperQueue.indexOf(cb);
      if (idx >= 0) _helperQueue[idx] = () => {}; // no-op consumer for any late reply
      console.error(\`[Safari MCP] safari-helper timeout (\${timeout}ms) — SIGKILL and restart\`);
      _helperProc?.kill("SIGKILL");
      _helperProc = null;
      _helperConsecutiveTimeouts = 0;
      incrementKillCount();
      setTimeout(() => { if (!_shuttingDown && !_helperProc) startHelper(); }, 100);
      reject(new Error(\`safari-helper timeout (\${timeout}ms)\`));`,
  'safari.js: _osascriptFastHelper SIGKILL on first timeout');

// === transport.js ===

// 11. Add import for getAsHealth
patch('transport.js',
  'import { _dropSession } from "./safari.js";',
  'import { _dropSession } from "./safari.js";\nimport { getAsHealth } from "./as-guard.js";',
  'transport.js: import getAsHealth');

// 12. Add /health endpoint before auth check
patch('transport.js',
  `    try {
      // --- Bearer token auth (remote mode only) ---`,
  `    try {
      // --- Health check (no auth, for monitoring) ---
      if (req.url === "/health") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(getAsHealth()));
        return;
      }

      // --- Bearer token auth (remote mode only) ---`,
  'transport.js: /health endpoint');

// === package.json ===

// 13. Add as-guard.js to files array
patch('package.json',
  '    "ownership-state.js",',
  '    "ownership-state.js",\n    "as-guard.js",',
  'package.json: add as-guard.js to files');

console.log(`\nTotal changes: ${changes.length}`);
console.log('Changes:', changes.join(', '));
