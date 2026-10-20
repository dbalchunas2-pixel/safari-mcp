#!/usr/bin/env node
// Phase 2: Hub hardening - per-request timeout, enriched health, JSON logs, /ping
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

// 1. Add hub health state and constants
patch('railway-hub.js',
  `const TUNNEL_TIMEOUT_MS = 60_000; // 60s - Safari AppleScript can be slow`,
  `const TUNNEL_TIMEOUT_MS = 60_000; // 60s - tunnel-alive timeout (must be > UPSTREAM_TIMEOUT_MS)
const UPSTREAM_TIMEOUT_MS = 55_000; // 55s - per-request upstream timeout

// Hub health state
const hubHealth = {
  totalRequests: 0,
  totalErrors: 0,
  lastError: null,
  lastErrorAt: null,
  lastHeartbeatAt: null,
  inflight: 0,
  startTime: Date.now(),
};

// JSON-line request logger
function logRequest(reqId, method, duration, outcome, extra = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    type: 'request',
    reqId, method, duration, outcome, ...extra,
  }));
}`,
  'railway-hub.js: hub health state + constants + logger');

// 2. Enrich /health endpoint + add 503 with JSON when offline
patch('railway-hub.js',
  `  if (req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      tunnelConnected: tunnelClient !== null && tunnelClient.readyState === 1,
    }));
    return;
  }`,
  `  if (req.url === "/health") {
    const tunnelConnected = tunnelClient !== null && tunnelClient.readyState === 1;
    res.setHeader("Content-Type", "application/json");
    if (!tunnelConnected) {
      res.statusCode = 503;
      res.end(JSON.stringify({
        status: "offline",
        tunnelConnected: false,
        lastHeartbeatAt: hubHealth.lastHeartbeatAt,
        inflight: hubHealth.inflight,
        totalRequests: hubHealth.totalRequests,
        totalErrors: hubHealth.totalErrors,
        lastError: hubHealth.lastError,
        lastErrorAt: hubHealth.lastErrorAt,
        uptime: Math.round((Date.now() - hubHealth.startTime) / 1000),
      }));
    } else {
      res.statusCode = 200;
      res.end(JSON.stringify({
        status: "ok",
        tunnelConnected: true,
        lastHeartbeatAt: hubHealth.lastHeartbeatAt,
        inflight: hubHealth.inflight,
        totalRequests: hubHealth.totalRequests,
        totalErrors: hubHealth.totalErrors,
        lastError: hubHealth.lastError,
        lastErrorAt: hubHealth.lastErrorAt,
        uptime: Math.round((Date.now() - hubHealth.startTime) / 1000),
      }));
    }
    return;
  }

  // Unauthenticated ping endpoint for external keep-alive (prevents Railway cold starts)
  if (req.url === "/ping") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }`,
  'railway-hub.js: enriched /health + /ping');

// 3. Track totalRequests + inflight in POST handler
patch('railway-hub.js',
  `    // Forward through tunnel
    const requestId = randomUUID();`,
  `    // Forward through tunnel
    const requestId = randomUUID();
    hubHealth.totalRequests++;
    hubHealth.inflight++;
    const reqStartTime = Date.now();`,
  'railway-hub.js: track requests + inflight');

// 4. Track success/error in POST response handler + JSON logging
patch('railway-hub.js',
  `    try {
      const tunnelResponse = await forwardThroughTunnel(requestId, {
        method: "POST",
        headers: forwardHeaders,
        body: rawBody, // Send raw body string - local daemon will parse it
      });

      res.statusCode = tunnelResponse.status || 200;`,
  `    try {
      const tunnelResponse = await forwardThroughTunnel(requestId, {
        method: "POST",
        headers: forwardHeaders,
        body: rawBody, // Send raw body string - local daemon will parse it
      });

      hubHealth.inflight--;
      const duration = Date.now() - reqStartTime;
      logRequest(requestId, 'POST', duration, tunnelResponse.status >= 400 ? 'error' : 'ok', { status: tunnelResponse.status });

      res.statusCode = tunnelResponse.status || 200;`,
  'railway-hub.js: track success + log request');

// 5. Track error in catch block + decrement inflight
patch('railway-hub.js',
  `    } catch (err) {
      console.error(\`Tunnel forwarding error for request \${requestId}:\`, err.message);
      res.statusCode = 502;`,
  `    } catch (err) {
      console.error(\`Tunnel forwarding error for request \${requestId}:\`, err.message);
      hubHealth.inflight--;
      hubHealth.totalErrors++;
      hubHealth.lastError = err.message;
      hubHealth.lastErrorAt = new Date().toISOString();
      const duration = Date.now() - reqStartTime;
      logRequest(requestId, 'POST', duration, 'error', { error: err.message });
      res.statusCode = 502;`,
  'railway-hub.js: track error + log');

// 6. Use UPSTREAM_TIMEOUT_MS in forwardThroughTunnel (per-request, not tunnel-alive)
patch('railway-hub.js',
  `    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(\`Tunnel request timeout (\${TUNNEL_TIMEOUT_MS / 1000}s)\`));
    }, TUNNEL_TIMEOUT_MS);`,
  `    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(\`Tunnel upstream timeout (\${UPSTREAM_TIMEOUT_MS / 1000}s)\`));
    }, UPSTREAM_TIMEOUT_MS);`,
  'railway-hub.js: use UPSTREAM_TIMEOUT_MS for per-request timeout');

// 7. Track lastHeartbeatAt on heartbeat
patch('railway-hub.js',
  `      } else if (msg.type === "heartbeat") {
        // Tunnel client heartbeat - just keep the connection alive
        ws.send(JSON.stringify({ type: "heartbeat-ack" }));
      }`,
  `      } else if (msg.type === "heartbeat") {
        // Tunnel client heartbeat - update lastHeartbeatAt
        hubHealth.lastHeartbeatAt = new Date().toISOString();
        ws.send(JSON.stringify({ type: "heartbeat-ack" }));
      }`,
  'railway-hub.js: track lastHeartbeatAt');

// 8. Track tunnel disconnect in health
patch('railway-hub.js',
  `  ws.on("close", (code, reason) => {
    console.log(\`Tunnel client disconnected: \${code} \${reason?.toString() || ""}\`);
    if (tunnelClient === ws) tunnelClient = null;`,
  `  ws.on("close", (code, reason) => {
    console.log(\`Tunnel client disconnected: \${code} \${reason?.toString() || ""}\`);
    if (tunnelClient === ws) tunnelClient = null;
    hubHealth.lastError = \`Tunnel disconnected: \${code}\`;
    hubHealth.lastErrorAt = new Date().toISOString();`,
  'railway-hub.js: track tunnel disconnect in health');

console.log('Phase 2 patch complete');
