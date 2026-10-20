// as-guard.js - AppleScript execution guard: health state, Safari probe,
// and request queue support for hard timeout enforcement.
//
// This module provides:
// 1. Shared health state read by the /health endpoint
// 2. A Safari responsiveness probe that runs after killed AppleScript calls
// 3. Kill counter and unresponsiveness flag for post-kill gating
//
// Env: SAFARI_MCP_AS_TIMEOUT_MS (default 20000) - hard per-request timeout

// --- Health state (module-level, shared across all calls) ---
export const asHealth = {
  inflight: 0,
  queueDepth: 0,
  killCount: 0,
  lastAsDurationMs: 0,
  lastError: null,
  lastErrorAt: null,
  safariUnresponsive: false,
  pid: process.pid,
  startTime: Date.now(),
};

const AS_TIMEOUT_MS = parseInt(process.env.SAFARI_MCP_AS_TIMEOUT_MS || "20000", 10);
const PROBE_TIMEOUT_MS = 5000;

// --- Safari probe ---
// Injected from safari.js (avoids circular import). Called after a killed
// AppleScript call to verify Safari is still responsive before accepting
// the next request.
let _probeFn = null;

export function setProbeFn(fn) {
  _probeFn = fn;
}

export async function probeSafari() {
  if (!_probeFn) return true;
  try {
    const result = await Promise.race([
      _probeFn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS)
      ),
    ]);
    return !!result;
  } catch {
    return false;
  }
}

// --- Kill counter ---
// Called from safari.js when an AppleScript process is SIGKILLed.
// Sets the unresponsive flag so the next call probes Safari first.
export function incrementKillCount() {
  asHealth.killCount++;
  asHealth.safariUnresponsive = true;
}

// --- Health snapshot ---
// Read by the /health endpoint in transport.js.
export function getAsHealth() {
  return {
    pid: asHealth.pid,
    uptime: Math.round((Date.now() - asHealth.startTime) / 1000),
    inflight: asHealth.inflight,
    queueDepth: asHealth.queueDepth,
    lastError: asHealth.lastError,
    lastErrorAt: asHealth.lastErrorAt,
    lastAsDurationMs: asHealth.lastAsDurationMs,
    killCount: asHealth.killCount,
    safariUnresponsive: asHealth.safariUnresponsive,
    asTimeoutMs: AS_TIMEOUT_MS,
  };
}
