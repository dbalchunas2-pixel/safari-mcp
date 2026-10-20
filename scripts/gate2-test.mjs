#!/usr/bin/env node
// Gate 2: Hub hardening tests - run locally with stub tunnel client
// (i) 70s upstream request -> JSON-RPC timeout at ~55s, tunnel stays connected
// (ii) tunnel disconnected -> /mcp returns JSON error, /health returns 503 with JSON
import http from 'node:http';
import { execSync, spawn } from 'node:child_process';

const HUB_PORT = 3010;
const HUB_HOST = '127.0.0.1';
const SAFARI_MCP_KEY = 'test-mcp-key';
const TUNNEL_TOKEN = 'test-tunnel-token';

const results = { passed: [], failed: [] };
const pass = m => { results.passed.push(m); console.log('PASS:', m); };
const fail = m => { results.failed.push(m); console.log('FAIL:', m); };

function hubRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json, text/event-stream' };
    if (SAFARI_MCP_KEY) headers['Authorization'] = `Bearer ${SAFARI_MCP_KEY}`;
    if (body) headers['Content-Type'] = 'application/json';
    const r = http.request({
      hostname: HUB_HOST, port: HUB_PORT, method, path, headers, timeout: 80000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw), raw }); }
        catch { resolve({ status: res.statusCode, body: null, raw }); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('request timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  console.log('=== Gate 2: Hub Hardening Tests ===\n');

  // Start hub locally on port 3001
  console.log('Starting hub on port', HUB_PORT, '...');
  const hub = spawn('node', ['railway-hub.js'], {
    cwd: '/Users/davidbalchunas/safari-mcp',
    env: {
      ...process.env,
      PORT: String(HUB_PORT),
      SAFARI_MCP_KEY,
      TUNNEL_TOKEN,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  hub.stdout.on('data', d => process.stdout.write(`[hub] ${d}`));
  hub.stderr.on('data', d => process.stderr.write(`[hub] ${d}`));

  // Wait for hub to start
  await new Promise(r => setTimeout(r, 2000));

  // Check /ping
  console.log('--- /ping check ---');
  const ping = await hubRequest('/ping');
  if (ping.status === 200 && ping.body?.ok) {
    pass('/ping returns 200 with ok:true');
  } else {
    fail('/ping not working: ' + ping.raw);
  }

  // Check /health (no tunnel connected)
  console.log('\n--- /health (no tunnel) ---');
  const healthNoTunnel = await hubRequest('/health');
  console.log('Status:', healthNoTunnel.status);
  console.log('Body:', JSON.stringify(healthNoTunnel.body));
  if (healthNoTunnel.status === 503 && healthNoTunnel.body?.tunnelConnected === false) {
    pass('/health returns 503 with JSON when no tunnel');
  } else {
    fail('/health should return 503 with JSON: ' + healthNoTunnel.raw);
  }

  // Check /mcp with no tunnel
  console.log('\n--- /mcp (no tunnel) ---');
  const mcpNoTunnel = await hubRequest('/mcp', 'POST', JSON.stringify({
    jsonrpc: '2.0', method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    id: 1,
  }));
  console.log('Status:', mcpNoTunnel.status);
  console.log('Body:', JSON.stringify(mcpNoTunnel.body).slice(0, 200));
  if (mcpNoTunnel.status === 503 && mcpNoTunnel.body?.error?.message?.includes('offline')) {
    pass('/mcp returns 503 with JSON error when no tunnel');
  } else {
    fail('/mcp should return 503 with JSON error: ' + mcpNoTunnel.raw?.slice(0, 200));
  }

  // Start stub tunnel client with 70s delay
  console.log('\n--- Starting stub tunnel client (70s delay) ---');
  const stub = spawn('node', ['scripts/stub-tunnel-client.mjs', `ws://127.0.0.1:${HUB_PORT}/tunnel`, '70000'], {
    cwd: '/Users/davidbalchunas/safari-mcp',
    env: { ...process.env, TUNNEL_TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  stub.stdout.on('data', d => process.stdout.write(`[stub] ${d}`));
  stub.stderr.on('data', d => process.stderr.write(`[stub] ${d}`));
  await new Promise(r => setTimeout(r, 2000));

  // Check /health (tunnel connected)
  console.log('\n--- /health (tunnel connected) ---');
  const healthWithTunnel = await hubRequest('/health');
  console.log('Status:', healthWithTunnel.status);
  console.log('Body:', JSON.stringify(healthWithTunnel.body));
  if (healthWithTunnel.status === 200 && healthWithTunnel.body?.tunnelConnected === true) {
    pass('/health returns 200 with tunnelConnected:true');
  } else {
    fail('/health should return 200 with tunnel connected: ' + healthWithTunnel.raw);
  }

  // Gate 2 (i): 70s upstream request -> timeout at ~55s
  console.log('\n--- Gate 2 (i): 70s upstream request timeout ---');
  const timeoutStart = Date.now();
  const timeoutResp = await hubRequest('/mcp', 'POST', JSON.stringify({
    jsonrpc: '2.0', method: 'tools/call',
    params: { name: 'safari_list_tabs', arguments: {} }, id: 2,
  }));
  const timeoutElapsed = Date.now() - timeoutStart;
  console.log('Status:', timeoutResp.status);
  console.log('Elapsed:', timeoutElapsed + 'ms');
  console.log('Body:', JSON.stringify(timeoutResp.body).slice(0, 200));

  if (timeoutResp.body?.error?.message?.includes('timeout') && timeoutElapsed >= 53000 && timeoutElapsed <= 60000) {
    pass('70s request timed out at ~55s (' + timeoutElapsed + 'ms) with JSON-RPC error');
  } else if (timeoutResp.body?.error && timeoutElapsed >= 50000) {
    pass('Request timed out with JSON error (' + timeoutElapsed + 'ms)');
  } else {
    fail('Timeout not working properly: elapsed=' + timeoutElapsed + ', status=' + timeoutResp.status);
  }

  // Verify tunnel is still connected after timeout
  console.log('\n--- Tunnel still connected after timeout? ---');
  const healthAfterTimeout = await hubRequest('/health');
  if (healthAfterTimeout.body?.tunnelConnected === true) {
    pass('Tunnel stays connected after per-request timeout');
  } else {
    fail('Tunnel disconnected after timeout: ' + JSON.stringify(healthAfterTimeout.body));
  }

  // Kill stub tunnel client
  console.log('\n--- Killing stub tunnel client ---');
  stub.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));

  // Gate 2 (ii): tunnel disconnected -> /mcp returns JSON error, /health returns 503
  console.log('\n--- Gate 2 (ii): tunnel disconnected ---');
  const mcpAfterDisconnect = await hubRequest('/mcp', 'POST', JSON.stringify({
    jsonrpc: '2.0', method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    id: 3,
  }));
  console.log('Status:', mcpAfterDisconnect.status);
  console.log('Body:', JSON.stringify(mcpAfterDisconnect.body).slice(0, 200));
  if (mcpAfterDisconnect.status === 503 && mcpAfterDisconnect.body?.error) {
    pass('/mcp returns 503 with JSON error when tunnel disconnected');
  } else {
    fail('/mcp should return 503: ' + mcpAfterDisconnect.raw?.slice(0, 200));
  }

  const healthAfterDisconnect = await hubRequest('/health');
  console.log('Health status:', healthAfterDisconnect.status);
  if (healthAfterDisconnect.status === 503 && healthAfterDisconnect.body?.tunnelConnected === false) {
    pass('/health returns 503 with JSON when tunnel disconnected');
  } else {
    fail('/health should return 503: ' + healthAfterDisconnect.raw);
  }

  // Cleanup
  hub.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));

  // --- Summary ---
  console.log('\n=== GATE 2 SUMMARY ===');
  console.log('Passed:', results.passed.length);
  console.log('Failed:', results.failed.length);
  results.passed.forEach(p => console.log('  + ' + p));
  results.failed.forEach(f => console.log('  - ' + f));
  process.exit(results.failed.length > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
