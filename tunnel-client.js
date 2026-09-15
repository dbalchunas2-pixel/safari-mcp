// tunnel-client.js - Daemon for David's Mac that maintains a reverse WebSocket tunnel
// to the Railway hub and proxies MCP requests to the local safari-mcp HTTP daemon.
//
// Architecture:
//   Railway Hub <--WebSocket /tunnel-- Tunnel Client (this file, launchd on Mac)
//   Tunnel Client --HTTP localhost:9225--> Safari MCP HTTP Daemon (spawned locally)
//   Safari MCP --AppleScript do JavaScript--> Safari Browser
//
// Env vars:
//   SAFARI_MCP_TUNNEL_URL  - wss:// URL of the Railway hub's /tunnel endpoint (REQUIRED)
//   TUNNEL_TOKEN            - Bearer token for tunnel auth (REQUIRED)
//   SAFARI_MCP_HTTP_PORT    - Local safari-mcp daemon port (default: 9225)
//   SAFARI_MCP_SPAWN_DAEMON - Set to "1" to auto-spawn the local daemon (default: 1)
//   SAFARI_MCP_DAEMON_CMD   - Override the daemon spawn command (default: "node index.js")
//
// Launchd plist: deploy/com.dbalchunas.safari-mcp-tunnel.plist
// Install: launchctl load ~/Library/LaunchAgents/com.dbalchunas.safari-mcp-tunnel.plist

import { spawn, execSync } from "node:child_process";
import { WebSocket } from "ws";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TUNNEL_URL = process.env.SAFARI_MCP_TUNNEL_URL;
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN;
const LOCAL_PORT = parseInt(process.env.SAFARI_MCP_HTTP_PORT || "9225", 10);
const LOCAL_HOST = "127.0.0.1";
const SPAWN_DAEMON = process.env.SAFARI_MCP_SPAWN_DAEMON !== "0";
const DAEMON_CMD = process.env.SAFARI_MCP_DAEMON_CMD || "node index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Verify required env vars
if (!TUNNEL_URL) {
  console.error("FATAL: SAFARI_MCP_TUNNEL_URL not set. Example: wss://your-app.up.railway.app/tunnel");
  process.exit(1);
}
if (!TUNNEL_TOKEN) {
  console.error("FATAL: TUNNEL_TOKEN not set. Generate a secure random token and set it on both Railway and locally.");
  process.exit(1);
}

let ws = null;
let localDaemon = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000; // Send heartbeat every 25s (Railway idle timeout is 30s)

let heartbeatTimer = null;

// ---------------------------------------------------------------------------
// Local daemon management
// ---------------------------------------------------------------------------
function spawnLocalDaemon() {
  if (localDaemon) return;
  console.log(`Starting local safari-mcp HTTP daemon on ${LOCAL_HOST}:${LOCAL_PORT}...`);

  const cmdParts = DAEMON_CMD.split(" ");
  const child = spawn(cmdParts[0], cmdParts.slice(1), {
    cwd: __dirname,
    env: {
      ...process.env,
      SAFARI_MCP_HTTP: "1",
      SAFARI_MCP_HTTP_PORT: String(LOCAL_PORT),
      // Do NOT set SAFARI_MCP_REMOTE or SAFARI_MCP_KEY here - the local daemon is localhost-only
      SAFARI_MCP_REMOTE: "",
      SAFARI_MCP_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  localDaemon = child;

  localDaemon.stdout.on("data", (d) => {
    const text = d.toString().trim();
    if (text) console.log(`[safari-mcp] ${text}`);
  });

  localDaemon.stderr.on("data", (d) => {
    const text = d.toString().trim();
    if (text) console.error(`[safari-mcp] ${text}`);
  });

  localDaemon.on("exit", (code, signal) => {
    console.log(`Local daemon exited (code=${code}, signal=${signal})`);
    localDaemon = null;
    // If the tunnel is still up, try to respawn after a delay
    if (ws && ws.readyState === 1) {
      console.log("Respawning local daemon in 3s...");
      setTimeout(spawnLocalDaemon, 3000);
    }
  });

  localDaemon.on("error", (err) => {
    console.error(`Failed to spawn local daemon: ${err.message}`);
    console.error(`  Command: ${DAEMON_CMD}`);
    console.error(`  CWD: ${__dirname}`);
    console.error(`  Make sure you are running from the safari-mcp directory.`);
    localDaemon = null;
  });
}

function stopLocalDaemon() {
  if (!localDaemon) return;
  console.log("Stopping local daemon...");
  localDaemon.kill("SIGTERM");
  localDaemon = null;
}

// ---------------------------------------------------------------------------
// Tunnel connection management
// ---------------------------------------------------------------------------
function connect() {
  console.log(`Connecting to tunnel hub: ${TUNNEL_URL}`);

  const headers = {
    Authorization: `Bearer ${TUNNEL_TOKEN}`,
  };

  try {
    ws = new WebSocket(TUNNEL_URL, { headers, handshakeTimeout: 10_000 });
  } catch (err) {
    console.error(`Failed to create WebSocket: ${err.message}`);
    scheduleReconnect();
    return;
  }

  ws.on("open", () => {
    console.log("Tunnel connected to Railway hub");
    reconnectDelay = 1000; // Reset exponential backoff on successful connect

    if (SPAWN_DAEMON) {
      // Wait a moment for the tunnel to stabilize, then spawn the local daemon
      setTimeout(spawnLocalDaemon, 500);
    }

    // Start heartbeat
    startHeartbeat();
  });

  ws.on("message", (data, isBinary) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "request") {
        handleTunnelRequest(msg);
      } else if (msg.type === "heartbeat-ack") {
        // Heartbeat acknowledged - connection is alive
      }
    } catch (e) {
      console.error("Error parsing tunnel message:", e.message);
    }
  });

  ws.on("pong", () => {
    // WebSocket ping/pong from the hub - connection is alive
  });

  ws.on("close", (code, reason) => {
    const reasonStr = reason?.toString() || "";
    console.log(`Tunnel disconnected: code=${code} ${reasonStr}`);
    stopHeartbeat();
    if (code === 4001) {
      console.error("Tunnel rejected: invalid TUNNEL_TOKEN. Check that it matches the Railway hub config.");
    }
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    // Don't log during reconnect storms - the close handler will log
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      console.error("Tunnel WebSocket error:", err.message);
    }
  });
}

function scheduleReconnect() {
  if (reconnectDelay < MAX_RECONNECT_DELAY) {
    console.log(`Reconnecting in ${reconnectDelay / 1000}s...`);
  }
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Request forwarding: tunnel -> local safari-mcp HTTP daemon
// ---------------------------------------------------------------------------
function handleTunnelRequest(msg) {
  const { id, method, headers, body } = msg;

  // Build request to local daemon
  const reqHeaders = { ...headers };
  delete reqHeaders["authorization"];
  delete reqHeaders["host"];
  delete reqHeaders["content-length"];
  delete reqHeaders["connection"];

  // Ensure content-type is set for POST
  if (method === "POST" && !reqHeaders["content-type"]) {
    reqHeaders["content-type"] = "application/json";
  }

  const req = http.request(
    {
      hostname: LOCAL_HOST,
      port: LOCAL_PORT,
      method: method,
      headers: reqHeaders,
      path: "/mcp",
      timeout: 55_000, // Slightly less than the hub's 60s timeout
    },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        // Send response back through tunnel
        sendTunnelResponse(id, {
          status: res.statusCode || 200,
          headers: res.headers,
          rawBody,
        });
      });
      res.on("error", (err) => {
        console.error(`Local response stream error for ${id}:`, err.message);
        sendTunnelResponse(id, {
          status: 502,
          headers: { "content-type": "application/json" },
          rawBody: JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: `Local daemon response error: ${err.message}` },
            id: null,
          }),
        });
      });
    }
  );

  req.on("error", (err) => {
    console.error(`Local request error for ${id}:`, err.message);
    const errorMsg = err.code === "ECONNREFUSED"
      ? `Local daemon not running on ${LOCAL_HOST}:${LOCAL_PORT}. ` +
        (SPAWN_DAEMON ? "Daemon may still be starting up." : "SAFARI_MCP_SPAWN_DAEMON=0 - daemon not auto-spawned.")
      : err.message;
    sendTunnelResponse(id, {
      status: 502,
      headers: { "content-type": "application/json" },
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: errorMsg },
        id: null,
      }),
    });
  });

  req.on("timeout", () => {
    console.error(`Local request timeout for ${id}`);
    req.destroy();
    sendTunnelResponse(id, {
      status: 504,
      headers: { "content-type": "application/json" },
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Local daemon request timeout (55s)" },
        id: null,
      }),
    });
  });

  if (body) req.write(body);
  req.end();
}

function sendTunnelResponse(id, response) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "response", id, ...response }));
  } else {
    console.error(`Cannot send response for ${id}: tunnel not connected`);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`${signal} received, shutting down tunnel client...`);
  stopHeartbeat();
  if (ws) {
    ws.close(1000, "Client shutting down");
  }
  stopLocalDaemon();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
console.log("Safari MCP Tunnel Client starting...");
console.log(`  Tunnel URL:  ${TUNNEL_URL}`);
console.log(`  Local port:  ${LOCAL_HOST}:${LOCAL_PORT}`);
console.log(`  Spawn daemon: ${SPAWN_DAEMON ? "yes" : "no"}`);
console.log(`  Daemon cmd:   ${DAEMON_CMD}`);
connect();
