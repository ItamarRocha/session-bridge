#!/usr/bin/env node
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Bridge } from './bridge.js';
import { Sessions } from './sessions.js';
import { claudeContextHook } from './context-hook.js';
import { defaultHome } from './paths.js';
import { doctor } from './doctor.js';
import { startMonitor } from './monitor.js';
import { startMcp } from './mcp.js';
import type { Host } from './types.js';

const usage = `Session Bridge — connect existing local Codex and Claude Code sessions

session-bridge doctor
session-bridge connect --host codex|claude --target [codex:|claude:]UUID
session-bridge sessions --host codex|claude [--limit N] [--cursor CURSOR]
session-bridge status-update --host codex|claude --text TEXT
session-bridge message-send --host codex|claude --target UUID --key KEY --body-file PATH [--reply-to MESSAGE | --notice]
session-bridge messages-read --host codex|claude [--message MESSAGE] [--limit N] [--cursor CURSOR]
session-bridge disconnect --host codex|claude --target UUID

Codex commands use the current shell's CODEX_THREAD_ID. Claude commands require a fresh
--session-id supplied by the current skill/hook, never the MCP startup environment.
MCP has six tools by default. --legacy-tools opts into the 0.1 catalog for migration.
The following legacy/operator commands remain available:
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
session-bridge monitor [--session-id UUID] [--label TEXT]

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
    'target', 'text', 'reply-to', 'limit', 'cursor',
  ].map(name => [name, { type: 'string' }]));
  options.help = { type: 'boolean' };
  options['legacy-tools'] = {type: 'boolean'};
  options.notice = {type: 'boolean'};
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
  if (command === 'context-hook') {
    let input = '';
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (Buffer.byteLength(input) > 262144) throw new Error('Hook input exceeds 256 KiB.');
    }
    const output = claudeContextHook(JSON.parse(input));
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }
  const home = resolve(option('home') ?? defaultHome());
  const codexCommand = option('codex-command') ?? process.env.SESSION_BRIDGE_CODEX_COMMAND;
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  if (command === 'doctor') { print(await doctor(home, codexCommand)); return; }
  if (command === 'monitor') {
    const monitor = await startMonitor(home, option('label') ?? '', line => process.stdout.write(`${line}\n`), option('session-id'));
    const stop = () => void monitor.close().catch(() => { process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  const store = new Store(home);
  if (command === 'mcp') {
    const instance = await startMcp(store, host(), codexCommand, {legacy: Boolean(values['legacy-tools'])});
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
    if (['connect', 'sessions', 'status-update', 'message-send', 'messages-read'].includes(command) || (command === 'disconnect' && option('target'))) {
      const provider = host();
      const nativeId = provider === 'codex' ? process.env.CODEX_THREAD_ID ?? option('session-id') : option('session-id');
      const sessions = new Sessions(store, provider, nativeId, codexCommand);
      switch (command) {
        case 'connect': print(await sessions.connect(required('target'))); break;
        case 'sessions': print(sessions.list({limit: option('limit') === undefined ? undefined : Number(option('limit')), cursor: option('cursor')})); break;
        case 'status-update': print(sessions.updateStatus(required('text'))); break;
        case 'message-send': print(await sessions.send({sessionId: required('target'), text: body(), idempotencyKey: required('key'), replyTo: option('reply-to'), expectsReply: values.notice ? false : undefined})); break;
        case 'messages-read': print(sessions.read({messageId: option('message'), limit: option('limit') === undefined ? undefined : Number(option('limit')), cursor: option('cursor')})); break;
        case 'disconnect': print(sessions.disconnect(required('target'))); break;
      }
      return;
    }
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
