#!/usr/bin/env node
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Bridge } from './bridge.js';
import { defaultHome } from './paths.js';
import { doctor } from './doctor.js';
import { startMonitor } from './monitor.js';
import { startMcp } from './mcp.js';
import type { Host } from './types.js';

const usage = `Session Bridge — connect existing local Codex and Claude Code sessions

session-bridge doctor
session-bridge attach --host codex --session-id UUID [--label TEXT]
session-bridge peers
session-bridge pair --self PEER --peer PEER
session-bridge send --self PEER --peer PEER --key KEY --body TEXT
session-bridge receive --self PEER --message MESSAGE
session-bridge reply --self PEER --message MESSAGE --claim CLAIM --body TEXT
session-bridge status --self PEER [--message MESSAGE]
session-bridge cancel --self PEER --message MESSAGE
session-bridge disconnect --self PEER --pairing PAIRING
session-bridge stop --self PEER
session-bridge mcp --host codex|claude
session-bridge monitor [--label TEXT]

Options: --home PATH (or SESSION_BRIDGE_HOME), --codex-command PATH.
For send/reply, --body-file PATH safely reads UTF-8 instead of --body.
Send also accepts --kind request|notice and --ttl-seconds 1..86400.
All regular commands emit JSON. MCP stdout is protocol-only; monitor stdout is notices-only.
No command starts, resumes, or duplicates a model session.
`;

async function main() {
  const options: ParseArgsOptionsConfig = Object.fromEntries([
    'home', 'host', 'session-id', 'label', 'self', 'peer', 'message', 'claim', 'pairing',
    'body', 'body-file', 'key', 'kind', 'ttl-seconds', 'codex-command',
  ].map(name => [name, { type: 'string' }]));
  options.help = { type: 'boolean' };
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options,
  });
  const command = positionals[0];
  if (!command || command === 'help' || values.help) {
    process.stdout.write(usage);
    return;
  }
  if (positionals.length !== 1) throw new Error('Use named options. Run session-bridge --help for syntax.');
  const option = (name: string) => typeof values[name] === 'string' ? values[name] as string : undefined;
  const required = (name: string) => {
    const value = option(name);
    if (!value) throw new Error(`Missing --${name}.`);
    return value;
  };
  const host = (): Host => {
    const value = required('host');
    if (value !== 'codex' && value !== 'claude') throw new Error('--host must be codex or claude.');
    return value;
  };
  const body = () => {
    const text = option('body');
    const file = option('body-file');
    if ((text === undefined) === (file === undefined)) throw new Error('Use exactly one of --body or --body-file.');
    if (!file) return text!;
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 32_768) throw new Error('Body file must be a regular UTF-8 file no larger than 32 KiB.');
    return readFileSync(file, 'utf8');
  };
  const home = resolve(option('home') ?? defaultHome());
  const codexCommand = option('codex-command') ?? process.env.SESSION_BRIDGE_CODEX_COMMAND;
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  if (command === 'doctor') { print(await doctor(home, codexCommand)); return; }
  if (command === 'monitor') {
    const monitor = await startMonitor(home, option('label') ?? '', line => process.stdout.write(`${line}\n`));
    const stop = () => void monitor.close().catch(() => { process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  const store = new Store(home);
  if (command === 'mcp') {
    const instance = await startMcp(store, host(), codexCommand);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { instance.bridge.detach(); } catch { /* Unattached connections own no peer. */ }
      store.close();
    };
    instance.server.server.onclose = cleanup;
    const stop = () => { cleanup(); void instance.server.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('exit', cleanup);
    return;
  }
  try {
    if (command === 'peers') { print(store.peers()); return; }
    if (command === 'attach') {
      if (host() !== 'codex') throw new Error('Claude attaches through the private ticket from its monitor, using bridge_attach in MCP.');
      const bridge = new Bridge(store, 'codex', codexCommand);
      print(bridge.attach({ sessionId: required('session-id'), label: option('label') }));
      return;
    }
    const self = store.peer(required('self'));
    const bridge = new Bridge(store, self.host, codexCommand);
    bridge.bindLocalPeer(self.id);
    switch (command) {
      case 'pair': print(bridge.pair(required('peer'))); break;
      case 'send': {
        const kind = option('kind') ?? 'request';
        if (kind !== 'request' && kind !== 'notice') throw new Error('--kind must be request or notice.');
        const ttl = option('ttl-seconds');
        print(await bridge.send({ to: required('peer'), body: body(), idempotencyKey: required('key'), kind, ttlSeconds: ttl === undefined ? undefined : Number(ttl) }));
        break;
      }
      case 'receive': print(bridge.receive(required('message'))); break;
      case 'reply': print(await bridge.reply(required('message'), required('claim'), body())); break;
      case 'status': print(bridge.status(option('message'))); break;
      case 'cancel': print(bridge.cancel(required('message'))); break;
      case 'disconnect': print(bridge.disconnect(required('pairing'))); break;
      case 'stop': print(bridge.detach()); break;
      default: throw new Error(`Unknown command: ${command}. Run session-bridge --help.`);
    }
  } finally { store.close(); }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'Bridge command failed.' })}\n`);
  process.exitCode = 1;
});
