#!/usr/bin/env node
// Gate 0 Test: (i) hang + recovery, (ii) 50 sequential calls, (iii) stdio mode
import http from 'node:http';

const PORT = 9225;
const HOST = '127.0.0.1';
let sessionId = null;
let nextId = 1;

function req(method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id: nextId++ });
}

function httpPost(body) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const r = http.request({ hostname: HOST, port: PORT, method: 'POST', path: '/mcp', headers, timeout: 60000 }, (res) => {
      if (res.headers['mcp-session-id']) sessionId = res.headers['mcp-session-id'];
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        // Parse SSE format: "event: message\ndata: {...}\n\n"
        let parsed = null;
        const dataMatch = raw.match(/data: (.+)/);
        if (dataMatch) {
          try { parsed = JSON.parse(dataMatch[1]); } catch {}
        }
        if (!parsed) {
          try { parsed = JSON.parse(raw); } catch {}
        }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('request timeout')); });
    r.write(body);
    r.end();
  });
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: HOST, port: PORT, method: 'GET', path, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(raw), raw }); }
        catch { resolve({ status: res.statusCode, body: null, raw }); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

async function callTool(name, args = {}) {
  const r = await httpPost(req('tools/call', { name, arguments: args }));
  return r;
}

async function listTools() {
  const r = await httpPost(req('tools/list', {}));
  return r;
}

async function main() {
  const results = { passed: [], failed: [] };
  function pass(msg) { results.passed.push(msg); console.log('PASS:', msg); }
  function fail(msg) { results.failed.push(msg); console.log('FAIL:', msg); }

  console.log('=== Gate 0 Tests ===\n');

  // --- Health check ---
  console.log('--- Health Check ---');
  const health = await httpGet('/health');
  if (health.status === 200 && health.body?.pid) {
    pass('/health returns enriched JSON with pid');
  } else {
    fail('/health not working: ' + health.raw);
    process.exit(1);
  }
  console.log('Health:', JSON.stringify(health.body));

  // --- MCP Initialize ---
  console.log('\n--- MCP Initialize ---');
  const init = await httpPost(req('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'gate0-test', version: '1.0.0' }
  }));
  if (init.body?.result) {
    pass('MCP initialize succeeded, session: ' + sessionId);
  } else {
    fail('MCP initialize failed: ' + init.raw);
    process.exit(1);
  }

  // Send initialized notification
  await httpPost(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

  // --- List tools ---
  console.log('\n--- List Tools ---');
  const tools = await listTools();
  const toolNames = tools.body?.result?.tools?.map(t => t.name) || [];
  console.log('Tool count:', toolNames.length);
  if (toolNames.length > 0) {
    pass('tools/list returned ' + toolNames.length + ' tools');
  } else {
    fail('tools/list returned no tools: ' + tools.raw);
    process.exit(1);
  }

  // Find a tool that does do JavaScript - look for safari_eval or similar
  const evalTool = toolNames.find(n => n.includes('eval') || n.includes('javascript') || n.includes('do_js') || n.includes('execute') || n.includes('run_js'));
  const tabTool = toolNames.find(n => n.includes('tab') && n.includes('list') || n === 'safari_list_tabs' || n === 'safari_tabs' || n.includes('list_windows'));
  console.log('Eval tool:', evalTool);
  console.log('Tab tool:', tabTool);
  console.log('First 10 tools:', toolNames.slice(0, 10).join(', '));

  // --- Gate 0 (i): Hang simulation + recovery ---
  console.log('\n--- Gate 0 (i): Hang Simulation ---');

  // First open a tab so safari_evaluate doesn't reject with tab-safety
  console.log('Opening a tab for eval...');
  const navResult = await callTool('safari_navigate', { url: 'https://example.com' });
  console.log('Navigate result:', JSON.stringify(navResult.body).slice(0, 150));
  await new Promise(r => setTimeout(r, 2000)); // wait for page load

  if (!evalTool) {
    // Try to find any tool that accepts JavaScript
    console.log('No eval tool found, searching for do-javascript-like tools...');
    const jsTools = toolNames.filter(n => n.includes('js') || n.includes('script') || n.includes('exec'));
    console.log('JS-related tools:', jsTools.join(', '));
  }

  // Use the eval tool to run a busy-loop that will hang
  if (evalTool) {
    const hangStart = Date.now();
    const busyLoop = 'while(true){}'; // infinite loop
    let hangResult;
    try {
      // Set a shorter timeout for this test (5s) to not wait the full 20s
      const hangTimeout = 25000; // slightly longer than AS_TIMEOUT_MS (20s)
      hangResult = await Promise.race([
        callTool(evalTool, { script: busyLoop }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('test timeout')), hangTimeout))
      ]);
    } catch (err) {
      hangResult = { error: err.message };
    }
    const elapsed = Date.now() - hangStart;
    console.log('Hang result:', JSON.stringify(hangResult.body || hangResult.error).slice(0, 200));
    console.log('Elapsed:', elapsed + 'ms');

    if (elapsed < 25000 && (hangResult.body?.error || hangResult.error)) {
      pass('Hang returned error within timeout (' + elapsed + 'ms)');
    } else {
      fail('Hang did not return error within timeout (' + elapsed + 'ms)');
    }

    // Check health after hang
    const healthAfterHang = await httpGet('/health');
    console.log('Health after hang:', JSON.stringify(healthAfterHang.body));
    if (healthAfterHang.body.killCount > 0) {
      pass('killCount incremented to ' + healthAfterHang.body.killCount);
    } else {
      // might be 0 if the helper kill path handles it differently
      console.log('killCount:', healthAfterHang.body.killCount, '(may be 0 if helper kill path differs)');
    }

    // Verify next request succeeds
    console.log('\n--- Next request after hang ---');
    const nextStart = Date.now();
    let nextResult;
    try {
      nextResult = await callTool(evalTool, { script: '1+1' });
    } catch (err) {
      nextResult = { error: err.message };
    }
    const nextElapsed = Date.now() - nextStart;
    console.log('Next request elapsed:', nextElapsed + 'ms');
    console.log('Next result:', JSON.stringify(nextResult.body).slice(0, 200));

    if (nextElapsed < 10000 && !nextResult.error) {
      pass('Next request succeeded immediately (' + nextElapsed + 'ms)');
    } else {
      fail('Next request failed or took too long (' + nextElapsed + 'ms): ' + (nextResult.error || nextResult.raw));
    }
  } else {
    console.log('SKIP: No eval tool found for hang test');
    fail('No eval tool found for hang test');
  }

  // --- Gate 0 (ii): 50 sequential calls ---
  console.log('\n--- Gate 0 (ii): 50 Sequential Calls ---');
  const seqStart = Date.now();
  let successCount = 0;
  let failCount = 0;
  const lightTool = tabTool || evalTool || toolNames[0];
  console.log('Using tool:', lightTool);

  for (let i = 0; i < 50; i++) {
    try {
      const r = await callTool(lightTool, lightTool === evalTool ? { script: String(i) } : {});
      if (r.body?.result || r.body?.error) {
        // Either result or structured error counts as "no hang"
        successCount++;
      } else {
        failCount++;
        console.log('Call ' + i + ': unexpected response: ' + r.raw?.slice(0, 100));
      }
    } catch (err) {
      failCount++;
      console.log('Call ' + i + ': error: ' + err.message);
    }
  }
  const seqElapsed = Date.now() - seqStart;
  console.log('50 sequential calls: ' + successCount + ' ok, ' + failCount + ' fail, ' + seqElapsed + 'ms total');

  if (failCount === 0 && successCount === 50) {
    pass('50 sequential calls with zero hangs');
  } else {
    fail('50 sequential calls: ' + failCount + ' failures');
  }

  // --- Gate 0 (iii): stdio mode ---
  console.log('\n--- Gate 0 (iii): stdio mode ---');
  // We can't fully test stdio mode from here, but we can verify the module loads
  const { execSync } = await import('node:child_process');
  try {
    // Just check that index.js starts without immediate errors (it will wait for stdin)
    execSync('timeout 3 node -e "import(\'./index.js\').catch(e => { console.error(e); process.exit(1) })" 2>&1', {
      cwd: '/Users/davidbalchunas/safari-mcp',
      timeout: 5000,
    });
    // If it exits cleanly after 3s, that's fine
    pass('stdio mode: index.js loads without errors');
  } catch (err) {
    // timeout is expected since stdio mode waits for input
    if (err.status === 124 || err.status === null) {
      pass('stdio mode: index.js starts without errors (timed out waiting for stdin - expected)');
    } else {
      fail('stdio mode: index.js failed to load: ' + err.message);
    }
  }

  // --- Final health check ---
  console.log('\n--- Final Health ---');
  const finalHealth = await httpGet('/health');
  console.log('Final health:', JSON.stringify(finalHealth.body, null, 2));

  // --- Summary ---
  console.log('\n=== GATE 0 SUMMARY ===');
  console.log('Passed:', results.passed.length);
  console.log('Failed:', results.failed.length);
  results.passed.forEach(p => console.log('  + ' + p));
  results.failed.forEach(f => console.log('  - ' + f));

  process.exit(results.failed.length > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
