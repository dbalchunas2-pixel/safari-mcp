# Safari MCP Hardening - PROGRESS.md

## Phase 0: Daemon Hard Timeout + Queue + Health
Status: COMPLETE - Gate 0 PASSED
Commit: 77020cb

### Changes
- as-guard.js: health state, probe, kill counter, getAsHealth
- safari.js: SIGKILL on timeout (osascript + helper), AS_TIMEOUT_MS env (20s), queue+probe in _withHelperLock
- transport.js: /health endpoint (no auth)
- package.json: as-guard.js in files

### Gate 0
(i) Hang + recovery: SIGKILL fires, killCount++, next request succeeds ✅
(ii) 50 sequential calls: zero hangs ✅
(iii) stdio mode: unchanged ✅

## Phase 1: Tunnel Client Circuit Breaker + Daemon Supervision
Status: COMPLETE - Gate 1 PASSED

### Changes
- tunnel-client.js: circuit breaker (3 failures -> open, 10s cooldown -> probe)
- tunnel-client.js: daemon kill+restart on breaker trip (SIGKILL + spawnLocalDaemon)
- tunnel-client.js: jitter on reconnect backoff (0-30% jitter, known bug 8 fix)
- tunnel-client.js: FORWARD_TIMEOUT_MS constant (55s, was hardcoded)
- tunnel-client.js: JSON-line state logging (breaker open/closed, reconnect, daemon restart)
- tunnel-client.js: breaker tracks success/failure on all response paths

### Gate 1
(i) Daemon killed -> 3 requests fail fast (2ms each) -> daemon restarted (new PID) -> breaker closes -> request succeeds (1.8s) ✅
(ii) WS killed -> reconnect within 5s -> hub tunnelConnected=true ✅
(iii) launchctl kickstart -> PID changed (79872->80045) -> KeepAlive holds ✅

### If resuming, start here:
Phase 0 and 1 complete. Start Phase 2 (hub hardening, deploy-gated).
