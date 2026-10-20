#!/usr/bin/env node
// Stub tunnel client for Gate 2 testing - connects to local hub, responds to
// requests with configurable delays. Does NOT require Safari or the daemon.
import { WebSocket } from 'ws';

const HUB_URL = process.argv[2] || 'ws://127.0.0.1:3001/tunnel';
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || 'test-tunnel-token';
const SLOW_DELAY_MS = parseInt(process.argv[3] || '70000', 10); // default 70s for timeout test

console.log(`Stub tunnel client connecting to ${HUB_URL} (slow delay: ${SLOW_DELAY_MS}ms)`);

const ws = new WebSocket(HUB_URL, {
  headers: { Authorization: `Bearer ${TUNNEL_TOKEN}` },
  handshakeTimeout: 5000,
});

ws.on('open', () => {
  console.log('Stub tunnel connected');
  // Start heartbeat
  setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat' }));
  }, 25000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'heartbeat-ack') return;
    if (msg.type === 'request') {
      console.log(`Got request ${msg.id}, responding in ${SLOW_DELAY_MS}ms...`);
      setTimeout(() => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'response',
            id: msg.id,
            status: 200,
            headers: { 'content-type': 'application/json' },
            rawBody: JSON.stringify({
              jsonrpc: '2.0',
              result: { content: [{ type: 'text', text: 'stub response' }] },
              id: 1,
            }),
          }));
          console.log(`Sent response for ${msg.id}`);
        }
      }, SLOW_DELAY_MS);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
});

ws.on('close', (code, reason) => {
  console.log(`Disconnected: ${code} ${reason}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

// Keep alive
setInterval(() => {}, 1000000);
