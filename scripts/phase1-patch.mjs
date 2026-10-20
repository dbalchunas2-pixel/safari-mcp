#!/usr/bin/env node
// Phase 1 patch: circuit breaker + daemon supervision + jitter + JSON logs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function patch(file, oldText, newText, desc) {
  const filePath = join(repoRoot, file);
  let content = readFileSync(filePath, 'utf8');
  if (!content.includes(oldText)) {
    console.error(`FAIL [${desc}]: oldText not found in ${file}`);
    process.exit(1);
  }
  if (content.includes(newText) && oldText !== newText) {
    console.log(`SKIP [${desc}]: already patched`);
    return;
  }
  content = content.replace(oldText, newText);
  writeFileSync(filePath, content, 'utf8');
  console.log(`OK   [${desc}]`);
}

// 1. Add circuit breaker state after HEARTBEAT_INTERVAL_MS
patch('tunnel-client.js',
  `let heartbeatTimer = null;`,
  `let heartbeatTimer = null;

// Circuit breaker state
const BREAKER_THRESHOLD = 3;       // consecutive failures to open
const BREAKER_COOLDOWN_MS = 10_000;  // cooldown before probe
const FORWARD_TIMEOUT_MS = 55_000;  // per-forward timeout (must be < hub's 60s)
let breakerFailures = 0;
let breakerOpen = false;
let breakerOpenedAt = 0;
let lastRequestSeq = 0;

// JSON-line logger for state transitions
function logState(event, extra = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));
}

// Circuit breaker helpers
function breakerCanForward() {
  if (!breakerOpen) return true;
  // Check if cooldown has elapsed
  if (Date.now() - breakerOpenedAt >= BREAKER_COOLDOWN_MS) {
    logState('breaker_probe', { reason: 'cooldown elapsed' });
    return true; // Allow one probe
  }
  return false;
}

function breakerRecordSuccess() {
  if (breakerOpen) {
    logState('breaker_closed', { failures: breakerFailures });
    breakerOpen = false;
    breakerFailures = 0;
  } else {
    breakerFailures = 0;
  }
}

function breakerRecordFailure(reqId, reason) {
  breakerFailures++;
  logState('breaker_failure', { reqId, reason, consecutive: breakerFailures });
  if (breakerFailures >= BREAKER_THRESHOLD && !breakerOpen) {
    breakerOpen = true;
    breakerOpenedAt = Date.now();
    logState('breaker_open', { reason, failures: breakerFailures });
    // Kill and restart the daemon
    restartLocalDaemon();
  }
}

function restartLocalDaemon() {
  logState('daemon_restart', { reason: 'breaker trip' });
  if (localDaemon) {
    try { localDaemon.kill('SIGKILL'); } catch {}
    localDaemon = null;
  }
  // Wait a moment then respawn
  setTimeout(() => {
    if (ws && ws.readyState === 1) {
      spawnLocalDaemon();
    }
  }, 500);
}`,
  'tunnel-client.js: circuit breaker + JSON logger');

// 2. Add jitter to scheduleReconnect (known bug 8)
patch('tunnel-client.js',
  `function scheduleReconnect() {
  if (reconnectDelay < MAX_RECONNECT_DELAY) {
    console.log(\`Reconnecting in \${reconnectDelay / 1000}s...\`);
  }
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}`,
  `function scheduleReconnect() {
  // Add jitter to prevent thundering-herd reconnect storms (known bug 8)
  const jitter = Math.random() * 0.3 * reconnectDelay; // 0-30% jitter
  const delay = reconnectDelay + jitter;
  if (reconnectDelay < MAX_RECONNECT_DELAY) {
    console.log(\`Reconnecting in \${(delay / 1000).toFixed(1)}s (base=\${reconnectDelay / 1000}s + jitter=\${(jitter / 1000).toFixed(1)}s)...\`);
  }
  logState('reconnect_scheduled', { delayMs: Math.round(delay), baseMs: reconnectDelay });
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, delay);
}`,
  'tunnel-client.js: jitter reconnect');

// 3. Add logState to connect/disconnect events
patch('tunnel-client.js',
  `    console.log("Tunnel connected to Railway hub");
    reconnectDelay = 1000; // Reset exponential backoff on successful connect`,
  `    console.log("Tunnel connected to Railway hub");
    reconnectDelay = 1000; // Reset exponential backoff on successful connect
    logState('tunnel_connected', { url: TUNNEL_URL });`,
  'tunnel-client.js: log tunnel_connected');

patch('tunnel-client.js',
  `    console.log(\`Tunnel disconnected: code=\${code} \${reasonStr}\`);`,
  `    console.log(\`Tunnel disconnected: code=\${code} \${reasonStr}\`);
    logState('tunnel_disconnected', { code, reason: reasonStr });`,
  'tunnel-client.js: log tunnel_disconnected');

// 4. Modify handleTunnelRequest to use circuit breaker + per-forward timeout
patch('tunnel-client.js',
  `function handleTunnelRequest(msg) {
  const { id, method, headers, body } = msg;`,
  `function handleTunnelRequest(msg) {
  const { id, method, headers, body } = msg;
  const seq = ++lastRequestSeq;

  // Circuit breaker check
  if (!breakerCanForward()) {
    logState('breaker_rejected', { reqId: id, seq });
    sendTunnelResponse(id, {
      status: 503,
      headers: { "content-type": "application/json" },
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "local daemon unhealthy (circuit breaker open)" },
        id: null,
      }),
    });
    return;
  }`,
  'tunnel-client.js: breaker check in handleTunnelRequest');

// 5. Track success/failure in the response handler
patch('tunnel-client.js',
  `      res.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        // Send response back through tunnel
        sendTunnelResponse(id, {
          status: res.statusCode || 200,
          headers: res.headers,
          rawBody,
        });
      });`,
  `      res.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode || 200;
        // Circuit breaker: track success/failure
        if (status >= 500) {
          breakerRecordFailure(id, \`daemon returned \${status}\`);
        } else {
          breakerRecordSuccess();
        }
        // Send response back through tunnel
        sendTunnelResponse(id, {
          status,
          headers: res.headers,
          rawBody,
        });
      });`,
  'tunnel-client.js: breaker tracking in response');

// 6. Track failure in error and timeout handlers
patch('tunnel-client.js',
  `  req.on("error", (err) => {
    console.error(\`Local request error for \${id}:\`, err.message);`,
  `  req.on("error", (err) => {
    console.error(\`Local request error for \${id}:\`, err.message);
    breakerRecordFailure(id, \`connection error: \${err.code || err.message}\`);`,
  'tunnel-client.js: breaker tracking on error');

patch('tunnel-client.js',
  `  req.on("timeout", () => {
    console.error(\`Local request timeout for \${id}\`);
    req.destroy();`,
  `  req.on("timeout", () => {
    console.error(\`Local request timeout for \${id}\`);
    breakerRecordFailure(id, 'forward timeout');
    req.destroy();`,
  'tunnel-client.js: breaker tracking on timeout');

// 7. Use FORWARD_TIMEOUT_MS constant instead of hardcoded 55_000
patch('tunnel-client.js',
  `      timeout: 55_000, // Slightly less than the hub's 60s timeout`,
  `      timeout: FORWARD_TIMEOUT_MS,`,
  'tunnel-client.js: use FORWARD_TIMEOUT_MS constant');

console.log('Phase 1 patch complete');
