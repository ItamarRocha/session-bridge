# Validation

The v0.3.0 baseline has automated protocol/process coverage and a confirmed native Claude → Codex → Claude exchange. v0.4.0 adds inbox notification batching and v0.5.0 adds Devin CLI; their native acceptance is separate from that earlier result. These establish different layers of behavior: storing or submitting a message alone does not prove the destination agent read it.

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

## v0.5.0 Devin acceptance

The automated gate passes **145 tests**, recorded 11 September 2026. Added coverage includes real stdio MCP/CLI helpers across three providers, fresh per-call Devin identity, explicit activation, passive schema preservation, migration rollback, token batching/replay, and bounded shutdown with an unread output pipe. `claude plugin validate .` passes with the explicitly selected Claude hook file. Independent delivery and existing-client compatibility reviews found no remaining concrete defects after the passive migration and stalled-output fixes.

The Devin adapter targets CLI **3000.10.21** and uses its documented plugin, MCP and lifecycle-hook interfaces. Native delivery acceptance has not been recorded. The [Devin research](devin-cli-research.md) lists the primary sources and required native checks.

Before claiming native support, verify separate current identities in two existing Devin conversations, fresh-terminal dormancy, explicit connection, all six methods, coalesced notices during work, and a substantive cross-provider result. An already-idle Devin should retain unread work until a lifecycle boundary or explicit read; `idleWakeAvailable: false` must remain visible. Hook emission alone cannot prove message receipt. An isolated native plugin-loader check stopped before installation because Devin required authentication. Hook loading remains unverified; no model session or installed user plugin was changed.

## v0.4.0 notification acceptance

The automated gate passes **120 tests** on Node.js 24.12.0, recorded 9 September 2026. The burst regression sends 20 distinct messages while reading proactively and verifies one outstanding native notification. Additional cases cover bounded successor pages, exact-token replay, empty-token rejection, historical native aliases and uncertain receiver output. Both plugin manifests validate.

The updated contract groups unread messages behind one outstanding notification per native recipient and bridge directory. Validation must distinguish delivered-token consumption from manual polling, bound each notification read to one page, and retain prior receipt/replay evidence. A new native trial should send a burst, observe a single pending wakeup, process its bounded inbox page, and verify that remaining unread messages can notify without acknowledgment loops. Also verify that receiver restart preserves submitting/submitted/unknown notifications without re-emission and that targeted/history reads recover unfinished requests. Earlier live results do not establish those new behaviors. v0.4.0 currently has integration coverage only; a native acceptance result has not been recorded.

## Automated coverage at v0.3.0

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
