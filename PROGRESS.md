# Safari MCP Hardening - PROGRESS.md

## Phase 0: Daemon Hard Timeout + Queue + Health
Status: COMPLETE - Gate 0 PASSED

### Changes Made
- [x] as-guard.js: health state, probe function, kill counter, getAsHealth
- [x] safari.js: import as-guard, AS_TIMEOUT_MS env var (default 20s)
- [x] safari.js: osascript() killSignal SIGKILL + health tracking
- [x] safari.js: _osascriptFastHelper SIGKILL on first timeout (was 5th)
- [x] safari.js: _withHelperLock queue depth tracking + queue-wait budget + post-kill probe
- [x] safari.js: Safari probe function (osascript subprocess, 3s timeout)
- [x] safari.js: osascriptFast() default timeout = AS_TIMEOUT_MS
- [x] transport.js: /health endpoint (no auth, enriched JSON)
- [x] package.json: as-guard.js added to files array

### Gate 0 Evidence

**Gate 0 (i): Hang simulation + recovery**
- Tested with daemon running at AS_TIMEOUT_MS=3000 (3s)
- safari_navigate to example.com triggered safari-helper timeout (10000ms)
- killCount incremented from 0 to 1 (helper was SIGKILLed)
- Helper auto-restarted within 100ms
- Next request (safari_list_tabs) succeeded in 655ms
- PASS ✅

**Gate 0 (ii): 50 sequential calls**
- 50 sequential safari_list_tabs calls against normal pages
- All 50 succeeded, zero hangs, 82-96s total
- PASS ✅

**Gate 0 (iii): stdio mode unchanged**
- `node -e "import('./index.js')"` loads without errors
- PASS ✅

### Notes
- Safari's own JS engine has a ~10s timeout for `do JavaScript`, so pure JS busy-loops complete before our 20s timeout. The hard timeout is a backstop for when Safari itself is unresponsive (heavy SPA pages, Safari frozen).
- The _osascriptFastHelper now SIGKILLs on first timeout (was 5th), which is more aggressive but prevents one stuck request from blocking all subsequent ones (known bug 2).
- The post-kill probe (osascript subprocess calling `get name of document 1`) runs before the next helper request to verify Safari is responsive.
- The _withHelperLock queue tracks depth and enforces queue-wait budget (fail fast if queued too long).

### If resuming, start here:
Phase 0 is complete and committed. Start Phase 1 (tunnel client circuit breaker + daemon supervision).
