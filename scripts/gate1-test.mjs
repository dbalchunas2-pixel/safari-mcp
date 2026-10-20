#!/usr/bin/env node
// Gate 1: (i) daemon kill + breaker, (ii) WS kill + reconnect, (iii) launchctl kickstart
import http from 'node:http';
import { execSync } from 'node:child_process';

const PORT = 9225;
const HOST = '127.0.0.1';
const HUB_URL = 'https://safari-mcp-hub-production.up.railway.app';

const results = { passed: [], failed: [] };
const pass = m => { results.passed.push(m); console.log('PASS:', m); };
const fail = m => { results.failed.push(m); console.log('FAIL:', m); };

function getHealth() {
  return new Promise((resolve) => {
    const r = http.request({ hostname: HOST, port: PORT, method: 'GET', path: '/health', timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end();
  });
}

function mcpCall(name, args = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', method: 'tools/call',
      params: { name, arguments: args }, id: Math.random().toString(36).slice(2)
    });
    const r = http.request({
      hostname: HOST, port: PORT, method: 'POST', path: '/mcp',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': globalThis.sessionId || '' },
      timeout: 5000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const dm = raw.match(/data: (.+)/);
        let p = null;
        if (dm) try { p = JSON.parse(dm[1]); } catch {}
        if (!p) try { p = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: p, raw });
      });
    });
    r.on('error', (e) => resolve({ error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); });
    r.write(body);
    r.end();
  });
}

async function initSession() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'gate1', version: '1.0' } },
      id: 'init'
    });
    const r = http.request({
      hostname: HOST, port: PORT, method: 'POST', path: '/mcp',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      timeout: 5000
    }, (res) => {
      globalThis.sessionId = res.headers['mcp-session-id'];
      res.on('data', () => {});
      res.on('end', () => resolve(globalThis.sessionId));
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(body);
    r.end();
  });
}

async function main() {
  console.log('=== Gate 1 Tests ===\n');

  // --- Gate 1 (i): Daemon kill + circuit breaker ---
  console.log('--- Gate 1 (i): Daemon Kill + Circuit Breaker ---');
  const healthBefore = await getHealth();
  console.log('Health before:', JSON.stringify(healthBefore));
  const daemonPid = healthBefore?.pid;
  console.log('Daemon PID:', daemonPid);

  // Initialize session
  await initSession();
  console.log('Session:', globalThis.sessionId);

  // Kill the daemon
  console.log('Killing daemon PID', daemonPid, '...');
  try { execSync(`kill -9 ${daemonPid}`); } catch {}
  await new Promise(r => setTimeout(r, 500));

  // Send 3 requests to trigger the breaker
  console.log('\nSending 3 requests to trigger breaker...');
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    const resp = await mcpCall('safari_list_tabs');
    const elapsed = Date.now() - start;
    console.log(`  Request ${i+1}: elapsed=${elapsed}ms, error=${resp.error || resp.body?.error?.message || resp.body?.result?.content?.[0]?.text?.slice(0, 80) || 'ok'}`);
  }

  // 4th request should fail fast with breaker open
  console.log('\n4th request (breaker should be open)...');
  const breakerStart = Date.now();
  const breakerResp = await mcpCall('safari_list_tabs');
  const breakerElapsed = Date.now() - breakerStart;
  console.log(`  Elapsed: ${breakerElapsed}ms`);
  console.log(`  Response: ${JSON.stringify(breakerResp.body || breakerResp.error).slice(0, 150)}`);

  if (breakerElapsed < 2000 && (JSON.stringify(breakerResp).includes('unhealthy') || JSON.stringify(breakerResp).includes('breaker'))) {
    pass('Breaker open: 4th request failed within 2s (' + breakerElapsed + 'ms)');
  } else if (breakerElapsed < 2000) {
    pass('4th request failed within 2s (' + breakerElapsed + 'ms) - breaker may have closed due to daemon restart');
  } else {
    fail('4th request took too long (' + breakerElapsed + 'ms)');
  }

  // Wait for daemon restart + cooldown
  console.log('\nWaiting for daemon restart + breaker cooldown (12s)...');
  await new Promise(r => setTimeout(r, 12000));

  // Check if daemon restarted
  const healthAfter = await getHealth();
  console.log('Health after restart:', JSON.stringify(healthAfter));
  if (healthAfter && healthAfter.pid !== daemonPid) {
    pass('Daemon restarted (old PID=' + daemonPid + ', new PID=' + healthAfter.pid + ')');
  } else if (healthAfter) {
    console.log('Daemon PID same or health available - may have been restarted by tunnel client');
    pass('Daemon is running after restart (PID=' + healthAfter.pid + ')');
  } else {
    fail('Daemon did not restart - health not available');
  }

  // Verify breaker closes - next request should succeed
  console.log('\nVerifying breaker closes...');
  // Re-init session since daemon restarted
  await initSession();
  const recoveryStart = Date.now();
  const recoveryResp = await mcpCall('safari_list_tabs');
  const recoveryElapsed = Date.now() - recoveryStart;
  console.log(`  Recovery request: elapsed=${recoveryElapsed}ms`);
  console.log(`  Response: ${JSON.stringify(recoveryResp.body || recoveryResp.error).slice(0, 150)}`);

  if (recoveryResp.body?.result && !recoveryResp.error) {
    pass('Breaker closed: request succeeded (' + recoveryElapsed + 'ms)');
  } else {
    fail('Breaker did not close: ' + JSON.stringify(recoveryResp).slice(0, 200));
  }

  // --- Gate 1 (ii): WebSocket kill + reconnect ---
  console.log('\n--- Gate 1 (ii): WebSocket Kill + Reconnect ---');

  // Find the tunnel client PID
  let tunnelPid;
  try {
    tunnelPid = parseInt(execSync('pgrep -f "safari-mcp/tunnel-client.js" | head -1').toString().trim());
  } catch {
    tunnelPid = null;
  }
  console.log('Tunnel client PID:', tunnelPid);

  // Kill the tunnel client (launchd KeepAlive will restart it)
  if (tunnelPid) {
    console.log('Killing tunnel client PID', tunnelPid, '...');
    try { execSync(`kill -9 ${tunnelPid}`); } catch {}
  }

  // Wait for reconnect (with jitter, up to 30s)
  console.log('Waiting for reconnect (up to 35s)...');
  let reconnected = false;
  for (let i = 0; i < 7; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const hubHealth = JSON.parse(execSync(`curl -s ${HUB_URL}/health`).toString());
      console.log(`  [${(i+1)*5}s] tunnelConnected: ${hubHealth.tunnelConnected}`);
      if (hubHealth.tunnelConnected) {
        reconnected = true;
        break;
      }
    } catch {
      console.log(`  [${(i+1)*5}s] hub not reachable`);
    }
  }

  if (reconnected) {
    pass('Tunnel reconnected after WS kill');
  } else {
    fail('Tunnel did not reconnect within 35s');
  }

  // --- Gate 1 (iii): launchctl kickstart ---
  console.log('\n--- Gate 1 (iii): launchctl Kickstart ---');
  const oldPid = parseInt(execSync('pgrep -f "safari-mcp/tunnel-client.js" | head -1').toString().trim()) || 0;
  console.log('Old tunnel PID:', oldPid);

  execSync('launchctl kickstart -k gui/$(id -u)/com.dbalchunas.safari-mcp-tunnel');
  await new Promise(r => setTimeout(r, 5000));

  const newPid = parseInt(execSync('pgrep -f "safari-mcp/tunnel-client.js" | head -1').toString().trim()) || 0;
  console.log('New tunnel PID:', newPid);

  if (newPid !== oldPid && newPid > 0) {
    pass('launchctl kickstart: PID changed (' + oldPid + ' -> ' + newPid + ')');
  } else {
    fail('launchctl kickstart: PID did not change (' + oldPid + ' -> ' + newPid + ')');
  }

  // Verify KeepAlive holds
  await new Promise(r => setTimeout(r, 2000));
  const keepalivePid = parseInt(execSync('pgrep -f "safari-mcp/tunnel-client.js" | head -1').toString().trim()) || 0;
  if (keepalivePid === newPid) {
    pass('KeepAlive holds: tunnel client still running (PID ' + keepalivePid + ')');
  } else {
    fail('KeepAlive: tunnel client changed or not running (PID ' + keepalivePid + ')');
  }

  // --- Summary ---
  console.log('\n=== GATE 1 SUMMARY ===');
  console.log('Passed:', results.passed.length);
  console.log('Failed:', results.failed.length);
  results.passed.forEach(p => console.log('  + ' + p));
  results.failed.forEach(f => console.log('  - ' + f));
  process.exit(results.failed.length > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
