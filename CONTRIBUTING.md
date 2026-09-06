# Contributing

Keep changes focused on helping existing sessions communicate. The bridge owns connections, durable messages, and delivery evidence. Goals, work assignment, and native permissions stay with the clients and agents. Read the [architecture](docs/architecture.md) and [six-method contract](docs/methods.md) before changing those boundaries.

## Local development

Use Node.js 24+ and npm:

```bash
npm ci
npm run verify
```

`verify` type-checks, builds `dist/`, and runs the test suite. `npm run build` rebuilds the CLI during development. Claude's manifest can be checked independently with `claude plugin validate .`.

Use a separate `SESSION_BRIDGE_HOME` for tests and development. Stop older helpers before trying a new schema against an existing ledger. Avoid altering a running user's client configuration to make a test pass.

## Repository map

| Location | Responsibility |
| --- | --- |
| `src/store.ts`, `src/types.ts` | SQLite persistence, identity, connections, receipts, and receiver ownership. |
| `src/sessions.ts` | The six-method interface over the ledger. |
| `src/bridge.ts`, `src/transport.ts` | Message dispatch and native Codex queue delivery. |
| `src/monitor.ts` | Claude inbox watcher and receiver lifecycle. |
| `src/cli.ts`, `src/mcp.ts` | CLI and MCP entry points. |
| `src/context-hook.ts` | Fresh Claude identity for each MCP call. |
| `src/codex-environment.ts`, `src/doctor.ts`, `src/paths.ts` | Environment selection and diagnostics. |
| `test/` | Store, adapter, facade, and process-level regression tests. |
| `commands/`, `skills/`, `hooks/` | User commands, agent instructions, and Claude hook configuration. |
| `.claude-plugin/`, `.codex-plugin/`, `claude.mcp.json` | Client packaging. |
| `docs/` | Setup, reference, architecture, support, and validation. |

## Changes and tests

Extend the existing interface before adding a method or another workflow mechanism. Preserve explicit activation, exact native addressing, connection boundaries, and durable duplicate protection. A successful queue write, native notification, receipt, and substantive result are different observations.

Use a focused regression for a behavioral change. Process lifecycle fixes should exercise real helper processes when a unit test cannot expose the failure. Automated tests use isolated state and simulated Codex queue delivery; they must not send messages to real sessions.

A native acceptance trial requires selected test conversations and a harmless bounded request. Record what was observed and what remains unverified in [validation](docs/validation.md). Publish a concise summary with representative identifiers; keep real conversation IDs, local account paths, and raw transcripts out of shared fixtures.

For documentation changes, check linked files, section anchors, command syntax, and consistency with the implementation. Generated `dist/`, dependencies, environment files, and local ledgers stay out of commits.

## Issues and pull requests

Include the triggering command or sequence, expected behavior, observed result, relevant versions, and a minimal reproduction. Remove credentials, account paths, conversation content, and identifying session IDs from examples.

Describe the resulting behavior and relevant validation in a PR. Distinguish automated coverage from native client observations. Keep unrelated cleanup separate, and explain schema or setup changes that affect existing installations.
