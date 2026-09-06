# Validation

Session Bridge v0.3.0 has automated protocol/process coverage and a confirmed native Claude → Codex → Claude exchange. These establish different layers of behavior: storing or submitting a message alone does not prove the destination agent read it.

## Tested baseline

| Component | Baseline |
| --- | --- |
| Environment | Local macOS, one OS account |
| Node.js | 24 |
| Codex CLI | 0.153.1 |
| Claude Code | 2.1.261 |
| Automated suite | 87 passing tests, recorded 5 September 2026 |

Run the local gate with:

```bash
npm run verify
```

## Automated coverage

Actual stdio MCP clients, CLI processes and receiver subprocesses exercise isolated ledgers: six methods, current-session identity, multiple peers, pagination, idempotency, receipts, cancellation/disconnect boundaries, routing and migration.

Receiver checks cover offline storage, process termination, lease expiry, restart under the same native ID, retained connections/receipts, and notification output failures. The inbox fixture prevents socket use, verifying durable-ledger delivery.

Host notifications and the Codex queue executable are simulated. These tests validate process/protocol behavior, not model behavior or every native host integration.

## Observed native exchange

On **5 September 2026**, an explicitly activated Claude conversation and an existing Codex task completed a harmless connectivity exchange through the six-method interface, using the Codex CLI fallback:

1. Claude's request was stored and submitted to the intended Codex queue.
2. The intended Codex task read the request and stored one reply.
3. Claude's receiver completed its notification output.
4. The original Claude conversation read the reply, without an automatic reply loop.

The return message was read about **five seconds after it was stored** in this trial. That is one observation, not a latency benchmark or guarantee. Both ends remained in their original conversations.

An earlier native Codex-to-Codex trial confirmed one-sided binding without a reciprocal connect. These CLI/receipt observations do not independently establish native Codex MCP packaging or Claude terminal rendering.

## Lessons incorporated

- **Queue routing:** a Codex command can accept a notification into a different account profile's queue. The explicit `SESSION_BRIDGE_CODEX_HOME` override and doctor diagnostics help select the intended route. Receipt in the intended task is still the proof of arrival. See [profile routing](support.md#codex-profile-routing).
- **Durable delivery:** earlier socket-based delivery could leave a reply stored without reaching Claude. The durable inbox watcher keeps eligible messages until an explicitly running receiver can notify the conversation, with notification and read tracked separately.
- **Uncertain outcomes:** a ledger write and a native queue write can have different permission requirements. Unknown delivery is inspected rather than automatically replayed; native permissions remain in force.

## Remaining limits

Native busy, paused, unloaded, crash/restart and `/clear` behavior still need separate acceptance trials. Fresh-terminal dormancy and read-only listing are covered locally but have not been independently demonstrated across all native host configurations. Multiple-peer routing is covered with isolated clients, not a group of four live models.

The bridge delivers messages; clients and model instructions determine continued work. It cannot guarantee progress after both clients become idle, interrupted or exited. See the [support guide](support.md) for compatibility and recovery, and the [architecture](architecture.md) for the delivery contract.
