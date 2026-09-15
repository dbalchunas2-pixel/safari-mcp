// railway-hub.js - WebSocket hub deployed on Railway that proxies MCP requests
// through a reverse tunnel to David's Mac running safari-mcp.
//
// Architecture:
//   Littlebird (cloud) --HTTPS POST/DELETE /mcp--> Railway Hub
//   Railway Hub --WebSocket /tunnel--> Tunnel Client (Mac, launchd)
//   Tunnel Client --HTTP localhost:9225--> Safari MCP HTTP Daemon
//   Safari MCP --AppleScript do JavaScript--> Safari Browser
//
// Env vars:
//   PORT          - Railway provides this automatically
//   SAFARI_MCP_KEY - Bearer token for /mcp endpoint auth (client-facing)
//   TUNNEL_TOKEN   - Bearer token for /tunnel WebSocket auth (Mac-facing)
//
// When the Mac is asleep/offline, /mcp returns 503 "Safari host offline".

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = parseInt(process.env.PORT || "3000", 10);
const SAFARI_MCP_KEY = process.env.SAFARI_MCP_KEY;
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN;

// The active tunnel WebSocket connection from the Mac.
// Single connection - one Mac, one tunnel.
let tunnelClient = null;

// Pending HTTP requests waiting for tunnel responses.
// Map<requestId, { resolve, reject, timeout }>
const pendingRequests = new Map();

const TUNNEL_TIMEOUT_MS = 60_000; // 60s - Safari AppleScript can be slow

// ---------------------------------------------------------------------------
// HTTP server: MCP endpoint for Littlebird and other cloud MCP clients
// ---------------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
  // Health check endpoint (no auth, for Railway uptime monitoring)
  if (req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      tunnelConnected: tunnelClient !== null && tunnelClient.readyState === 1,
    }));
    return;
  }

  // Only /mcp is a valid MCP endpoint
  if (req.url !== "/mcp") {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // --- Bearer token auth ---
  if (SAFARI_MCP_KEY) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${SAFARI_MCP_KEY}`) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unauthorized: invalid or missing bearer token" },
        id: null,
      }));
      return;
    }
  }

  // --- POST: MCP request (initialize, tools/list, tools/call, etc.) ---
  if (req.method === "POST") {
    let body;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: invalid JSON" },
        id: null,
      }));
      return;
    }

    // Check tunnel connectivity
    if (!tunnelClient || tunnelClient.readyState !== 1) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Safari host offline - Mac tunnel not connected" },
        id: body?.id ?? null,
      }));
      return;
    }

    // Forward through tunnel
    const requestId = randomUUID();
    const forwardHeaders = { ...req.headers };
    // Strip auth header - the local daemon doesn't need it (localhost, no auth)
    delete forwardHeaders["authorization"];
    delete forwardHeaders["host"];
    delete forwardHeaders["content-length"];
    delete forwardHeaders["connection"];

    try {
      const tunnelResponse = await forwardThroughTunnel(requestId, {
        method: "POST",
        headers: forwardHeaders,
        body: rawBody, // Send raw body string - local daemon will parse it
      });

      res.statusCode = tunnelResponse.status || 200;
      // Forward relevant headers from the local daemon
      if (tunnelResponse.headers) {
        for (const [key, value] of Object.entries(tunnelResponse.headers)) {
          // Skip hop-by-hop headers
          if (["connection", "keep-alive", "transfer-encoding", "date", "host"].includes(key)) continue;
          res.setHeader(key, value);
        }
      }
      // Ensure content-type is set
      if (!res.hasHeader("content-type")) {
        res.setHeader("Content-Type", "application/json");
      }
      res.end(tunnelResponse.rawBody || JSON.stringify(tunnelResponse.body || {}));
    } catch (err) {
      console.error(`Tunnel forwarding error for request ${requestId}:`, err.message);
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Tunnel error: ${err.message}` },
        id: body?.id ?? null,
      }));
    }
    return;
  }

  // --- DELETE: session termination ---
  if (req.method === "DELETE") {
    if (tunnelClient && tunnelClient.readyState === 1) {
      const requestId = randomUUID();
      try {
        await forwardThroughTunnel(requestId, {
          method: "DELETE",
          headers: { "mcp-session-id": req.headers["mcp-session-id"] },
          body: "",
        });
      } catch {
        // Ignore errors on delete - session cleanup is best-effort
      }
    }
    res.statusCode = 204;
    res.end();
    return;
  }

  // --- GET: SSE notifications stream ---
  // Railway buffers SSE, and the tunnel proxy adds another async layer.
  // Return 405 - the MCP client will fall back to request/response only.
  // This is fine for safari-mcp since all tools are synchronous request/response.
  if (req.method === "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "GET (SSE notifications) not supported through tunnel proxy" },
      id: null,
    }));
    return;
  }

  res.statusCode = 405;
  res.setHeader("Allow", "POST, DELETE");
  res.end();
});

// ---------------------------------------------------------------------------
// WebSocket server: tunnel endpoint for the Mac tunnel client
// ---------------------------------------------------------------------------
const wsServer = new WebSocketServer({ server: httpServer, path: "/tunnel" });

wsServer.on("connection", (ws, req) => {
  // Authenticate tunnel client
  if (TUNNEL_TOKEN) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${TUNNEL_TOKEN}`) {
      console.error("Tunnel connection rejected: invalid or missing token");
      ws.close(4001, "Unauthorized");
      return;
    }
  }

  // If there's an existing tunnel connection, replace it (the Mac may have reconnected)
  if (tunnelClient && tunnelClient.readyState === 1) {
    console.log("Replacing existing tunnel connection");
    tunnelClient.close(4000, "Replaced by new connection");
  }

  tunnelClient = ws;
  console.log(`Tunnel client connected from ${req.socket.remoteAddress}`);

  ws.on("message", (data, isBinary) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response" && pendingRequests.has(msg.id)) {
        const { resolve, timeout } = pendingRequests.get(msg.id);
        clearTimeout(timeout);
        pendingRequests.delete(msg.id);
        resolve(msg);
      } else if (msg.type === "heartbeat") {
        // Tunnel client heartbeat - just keep the connection alive
        ws.send(JSON.stringify({ type: "heartbeat-ack" }));
      }
    } catch (e) {
      console.error("Error processing tunnel message:", e.message);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`Tunnel client disconnected: ${code} ${reason?.toString() || ""}`);
    if (tunnelClient === ws) tunnelClient = null;
    // Reject all pending requests - the Mac went away
    for (const [id, { reject, timeout }] of pendingRequests) {
      clearTimeout(timeout);
      reject(new Error("Tunnel disconnected"));
      pendingRequests.delete(id);
    }
  });

  ws.on("error", (err) => {
    console.error("Tunnel WebSocket error:", err.message);
  });
});

// ---------------------------------------------------------------------------
// Tunnel forwarding: send request through WebSocket, await response
// ---------------------------------------------------------------------------
function forwardThroughTunnel(id, request) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Tunnel request timeout (${TUNNEL_TIMEOUT_MS / 1000}s)`));
    }, TUNNEL_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timeout });
    tunnelClient.send(JSON.stringify({ type: "request", id, ...request }));
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Safari MCP Railway Hub listening on 0.0.0.0:${PORT}`);
  console.log(`  MCP endpoint:   POST/DELETE /mcp`);
  console.log(`  Tunnel endpoint: ws://<host>/tunnel`);
  console.log(`  Health check:    GET /health`);
  if (!SAFARI_MCP_KEY) console.warn("  WARNING: SAFARI_MCP_KEY not set - /mcp endpoint has NO auth!");
  if (!TUNNEL_TOKEN) console.warn("  WARNING: TUNNEL_TOKEN not set - tunnel has NO auth!");
});

// Heartbeat: check tunnel health every 30s
setInterval(() => {
  if (tunnelClient && tunnelClient.readyState === 1) {
    tunnelClient.ping();
  }
}, 30_000);
