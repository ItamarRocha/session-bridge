# Session Bridge live validation

Historical native evidence recorded 5 September 2026 for the v0.2 implementation on `codex/simple-session-interface`. The v0.3.0 durable inbox receiver has a separately recorded native Claude/Codex roundtrip below. The native trial used an isolated ledger and two newly created Codex desktop tasks. The existing installed plugin and main checkout were not replaced.

## Observed Codex roundtrip

Codex CLI: **0.153.1**, invoked through `/Applications/ChatGPT.app/Contents/Resources/codex`. Claude Code **2.1.261** participated in the later interactive attempt described below; a Claude/Codex roundtrip had not been established at that checkpoint.

| Task | Native ID |
| --- | --- |
| Session Bridge live sender test | `01a07409-c238-7ac1-afbc-212300398516` |
| Session Bridge live receiver test | `01a07409-595e-7f82-94f0-9ac77ffeda21` |

The receiver first reported its own ID and ended its turn without registering or connecting. The sender connected to `codex:<receiver ID>` and received `pending`. A later native queue notification reached that original receiver; its eligible targeted read bound the existing connection. It never performed a reciprocal connect.

The final request asked for the uppercase of “roundtrip with permissions” and the receiver's own ID. Both sends used the client's normal permission flow for native queue access. The original receiver returned `ROUNDTRIP WITH PERMISSIONS` and its matching native ID. A native queue notification then woke the original sender, which recorded the reply receipt, validated both values, and ended without replying to the reply.

- Request: `msg_98fab31b-d55d-4e6b-aa91-dfe9482bc087`; submitted and received; exactly one result recorded.
- Reply: `msg_5f68d47c-31d3-46cf-8b8a-ae1a6b70e37d`; submitted and received by the original sender.
- Receiver's final turn: `01a07412-2e5e-72c1-ac95-c947e1c1c45f`.
- Sender's reply-processing turn: `01a07412-a38f-79c2-98e0-d80174810c71`.

The [ledger evidence](evidence/codex-roundtrip-2026-09-05.json) records message identity, native participants, receipt timestamps and reply linkage. Native task summaries independently confirmed the result and the unchanged task identities. This was a CLI fallback trial in real model tasks; it does not establish native Codex MCP packaging or Claude host behavior.

## Earlier failures are retained

The first sandboxed send returned `unknown` and was not automatically retried. It was explicitly cancelled before a separate test request. The second request submitted and reached the receiver, but its sandboxed reply returned `unknown`. That stored reply was subsequently inspected directly in the sender after an explicit test instruction; this second exchange is not counted as a successful return notification.

The final trial used the normal permission flow for both native queue writes and completed. These observations show the difference between a bridge ledger write and native queue submission. No permission settings were weakened, unknown sends replayed, or replacement model sessions created by the bridge.

## Claude attempt: accepted into another Codex profile

The user launched a fresh interactive Claude session with the test checkout, explicitly activated the bridge and requested a harmless reply from the existing Codex receiver. Claude reported `submitted` and one running monitor. The intended Codex task showed no new receiving turn, and the bridge had no recipient receipt or substantive reply for this request.

Read-only inspection established that Claude's Codex child inherited an Orca-managed account's `CODEX_HOME`, while the destination Codex client used a different home. The exact bridge request was found, still queued, in the inherited account profile's `queue_1.sqlite`. The CLI had successfully stored the notification there; it had not delivered it to the intended owner. Account identifiers, email and private profile paths are omitted from this record.

The routing fix adds the explicit `SESSION_BRIDGE_CODEX_HOME` override and corresponding doctor diagnostics described in [support](support.md#codex-profile-routing). It preserves inherited profiles by default and changes only the Codex child environment. That checkpoint did not establish a live Claude roundtrip or move the original queued request. No automatic resend should be inferred from the fix. A new acceptance result requires the intended Codex task's receipt and substantive reply, followed by receipt in the original Claude conversation.

## Historical automated evidence and acceptance at v0.2

`npm run verify` passed **61 tests**, including isolated four-session collaboration, same-provider and cross-provider routing, connected-only status, receipt/reply idempotency, SQL pagination, stale notifications, missing or stale native identity, actual stdio MCP clients, simulated Claude hook input, owned Unix sockets and legacy migration. Codex and Claude plugin validators also passed.

After the profile-routing correction, `npm run verify` passed **64 tests**. New regression coverage checks the actual child environment, rejection of invalid overrides before dispatch, and consistent doctor routing while preserving Claude's inherited environment. The live doctor probe reported the selected destination home and no `CODEX_SQLITE_HOME` override; this version/help check does not establish message reception.

| Layer | Evidence |
| --- | --- |
| Existing Codex task receives a native notification | Observed in the receiver above |
| One-sided native-ID binding and one substantive reply | Observed |
| Reply wakes the original sender without a reply loop | Observed in the final trial |
| Four-session routing and disconnecting one edge | Automated isolated clients; not four live models |
| Six MCP tools and per-call identity | Actual stdio clients, published Codex metadata contract and simulated Claude hook input |
| Claude native `Monitor`, `/clear`, fresh-terminal dormancy | Interactive attempt reported an active monitor; native notification receipt, `/clear` and dormancy remain unverified |
| Claude request reaches the intended Codex owner and returns | Not established; the observed request remained queued under another inherited Codex profile |
| Busy, paused, unloaded and restarted native clients | Not established by this live trial |
| Automatic native permission approval | Outside this version; native permission rules remain in force |

The computer-use tool denied access to Terminal, so the user was given a session-scoped Claude launch command for the isolated worktree. No alternative control path was used to bypass that denial. The user's subsequent trial exposed the profile-routing failure recorded above; it does not change the earlier successful Codex-only result.


## v0.3.0 receiver validation

The reliability implementation replaces Claude per-message socket delivery with a durable SQLite inbox watcher, adds receiver lease availability and preserves native identity/history/connections across watcher restart. Explicit activation now asks the native Monitor to persist across turns. The six public methods and client permission boundaries remain unchanged.

Local `npm run verify` passed 87 tests on 5 September 2026, including a real receiver subprocess killed with SIGKILL, lease expiry, offline storage, explicit restart under the same native ID, preserved connections/receipts and one final reply. The MCP fixture blocks the IPC directory with a regular file, so its exchange cannot use bridge sockets. Full stdout pipes also verify bounded CLI exit on failures during startup and notification output. These are process and protocol checks with simulated host notifications and a fake Codex queue executable; they do not run a Claude model.

The earlier Codex result, failed Claude routing attempt and automated counts above describe their recorded versions. They do not prove the new receiver's behavior in Claude's native UI. The live roundtrip below confirms basic delivery. To establish native restart recovery, still observe a harmless Claude-bound request remaining queued while its watcher is stopped, explicit restart in the original native conversation, notification followed by an actual agent read and one substantive result, and preserved connections/history. Also verify that a fresh terminal and read-only session listing do not activate a watcher.

The new implementation and test checkout do not replace the user's installed live plugin or upgrade its ledger. Any native trial must identify the checkout/version, isolated or upgraded ledger, and original conversation IDs used.


## Observed v0.3.0 Claude/Codex roundtrip

On 5 September 2026 (PDT), the user launched the v0.3.0 test checkout and explicitly connected Claude session `e9abb110-e66e-469e-864f-80f248bcf378` to the existing Codex task `01a07056-03b8-77b1-864a-470e8dcece14`. The isolated ledger was separate from the earlier installation. Tested source: `d31c0ba`.

Claude requested a harmless connectivity result. Its native queue notification reached that exact Codex task; the task recorded its first receipt and returned “pong from Codex” through the six-method CLI fallback. Sending the Claude-bound reply needed no socket access or sandbox escalation. The activated inbox watcher emitted the reply ID and the original Claude session recorded its read.

| Event | Evidence | UTC time on 6 September |
| --- | --- | --- |
| Claude request stored | `msg_bf8b0739-6806-425a-a07c-9385067a4290` | 02:46:16.151 |
| Original Codex task read it | First receipt, eligible unanswered request | 02:46:42.324 |
| One reply stored | `msg_183c95ec-1773-46f2-9471-32bddb729116` | 02:46:55.046 |
| Inbox watcher completed notification | `notifiedAt` recorded | 02:46:55.122 |
| Original Claude session read the reply | `acknowledgedAt` recorded | 02:47:00.018 |

[Selected ledger evidence](evidence/claude-codex-roundtrip-v030-2026-09-05.json) preserves native participants, message linkage, timestamps and the single-reply count. Claude receiver availability was also observed as `available`; connection state remained `connected`. The return progressed from queued to notified in 76 ms and to read in about five seconds in this trial; this is an observation, not a latency guarantee.

This confirms the native request and return-receipt path. It does not establish busy-client behavior, native crash/restart recovery, `/clear`, fresh-terminal dormancy, or a second Claude-bound work request. Claude terminal rendering was not independently captured. No bridge reply to the terminal result was sent.
