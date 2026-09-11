#!/usr/bin/env node
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, StoreSchemaVersionError } from './store.js';
import { Bridge } from './bridge.js';
import { Sessions } from './sessions.js';
import { claudeContextHook, devinContextHook } from './context-hook.js';
import { runDevinInboxHook } from './inbox-hook.js';
import { canonicalSessionId, isHost } from './providers.js';
import { defaultHome } from './paths.js';
import { doctor } from './doctor.js';
import { startMonitor } from './monitor.js';
import { startMcp } from './mcp.js';
import type { Host } from './types.js';

const usage = `Session Bridge — connect existing local Codex, Claude Code and Devin sessions

session-bridge doctor
session-bridge connect --host codex|claude|devin --target [codex:|claude:|devin:]SESSION_ID
session-bridge sessions --host codex|claude|devin [--limit N] [--cursor CURSOR]
session-bridge status-update --host codex|claude|devin --text TEXT
session-bridge message-send --host codex|claude|devin --target SESSION_ID --key KEY --body-file PATH [--reply-to MESSAGE | --notice]
session-bridge messages-read --host codex|claude|devin [--message MESSAGE | --notification-token TOKEN | --unread-only] [--limit N] [--cursor CURSOR]
session-bridge disconnect --host codex|claude|devin --target SESSION_ID

Codex commands use the current shell's CODEX_THREAD_ID. Claude and Devin commands require a fresh
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
session-bridge mcp --host codex|claude|devin
session-bridge monitor [--session-id UUID] [--label TEXT]
session-bridge context-hook [--host claude|devin]
session-bridge inbox-hook --host devin

Options: --home PATH (or SESSION_BRIDGE_HOME), --codex-command PATH.
For send/reply, --body-file PATH safely reads UTF-8 instead of --body.
Send also accepts --kind request|notice and --ttl-seconds 1..86400.
All regular commands emit JSON. MCP stdout is protocol-only; monitor stdout is notices-only.
No command starts, resumes, or duplicates a model session.
Devin receives at PostToolUse/UserPromptSubmit hooks; it cannot be woken while idle.
`;

async function main() {
  const options: ParseArgsOptionsConfig = Object.fromEntries([
    'home', 'host', 'session-id', 'label', 'self', 'peer', 'message', 'claim', 'pairing',
    'body', 'body-file', 'key', 'kind', 'ttl-seconds', 'codex-command',
    'target', 'text', 'reply-to', 'limit', 'cursor', 'notification-token',
  ].map(name => [name, { type: 'string' }]));
  options.help = { type: 'boolean' };
  options['legacy-tools'] = {type: 'boolean'};
  options.notice = {type: 'boolean'};
  options['unread-only'] = {type: 'boolean'};
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
    if (!isHost(value)) throw new Error('--host must be codex, claude or devin.');
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
  if (command === 'context-hook' || command === 'inbox-hook') {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (Buffer.byteLength(input) > 262144) throw new Error('Hook input exceeds 256 KiB.');
    }
    const payload: unknown = JSON.parse(input);
    if (command === 'context-hook') {
      const provider = option('host') ?? 'claude';
      if (provider !== 'claude' && provider !== 'devin') throw new Error('Context hooks support Claude and Devin only.');
      const output = provider === 'devin' ? devinContextHook(payload) : claudeContextHook(payload);
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
      return;
    }
    if (host() !== 'devin') throw new Error('Inbox hooks support Devin only.');
    const hookHome = resolve(option('home') ?? defaultHome());
    if (!existsSync(join(hookHome, 'bridge.sqlite'))) return;
    let store: Store;
    try { store = new Store(hookHome, Date.now, {migrate: false}); }
    catch (error) { if (error instanceof StoreSchemaVersionError) return; throw error; }
    // Retain the stream error listener until exit: a late EPIPE must not escape the hook result.
    process.stdout.on('error', () => { process.exitCode = 1; });
    try {
      await runDevinInboxHook(payload, store, output => new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => { process.stdout.destroy(); reject(new Error('Hook output timed out.')); }, 2000);
        process.stdout.write(`${JSON.stringify(output)}\n`, error => {
          clearTimeout(deadline);
          if (error) reject(error); else resolve();
        });
      }));
    } finally {
      store.close();
      // Node can retain a stalled pipe write even after stdout.destroy().
      const exitDeadline = setTimeout(() => { process.exit(process.exitCode ?? 0); }, 250);
      exitDeadline.unref();
    }
    return;
  }
  const home = resolve(option('home') ?? defaultHome());
  const codexCommand = option('codex-command') ?? process.env.SESSION_BRIDGE_CODEX_COMMAND;
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  if (command === 'doctor') { print(await doctor(home, codexCommand)); return; }
  if (option('host') === 'devin' && values['legacy-tools']) throw new Error('Devin supports the six native session methods only.');
  if (command === 'monitor') {
    let monitor: Awaited<ReturnType<typeof startMonitor>> | undefined;
    let outputError: Error | undefined;
    process.stdout.on('error', error => {
      outputError = error;
      void monitor?.close().catch(() => { process.exitCode = 1; });
    });
    const output = (line: string) => new Promise<void>((resolve, reject) => {
      process.stdout.write(`${line}\n`, error => error ? reject(error) : resolve());
    });
    const stop = () => void monitor?.close().catch(() => { process.exitCode = 1; });
    try {
      monitor = await startMonitor(home, option('label') ?? '', output, option('session-id'));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await monitor.done;
      if (outputError) throw outputError;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      // Node can retain a pipe write after stdout.destroy(); bound shutdown after releasing the lease.
      process.stdout.destroy();
      const exitDeadline = setTimeout(() => { process.exit(process.exitCode ?? 0); }, 250);
      exitDeadline.unref();
    }
    return;
  }
  let currentStore: Store | undefined;
  const openStore = (activate: boolean) => {
    if (currentStore) return currentStore;
    if (!activate && !existsSync(join(home, 'bridge.sqlite'))) return null;
    try { return currentStore = new Store(home, Date.now, {migrate: activate}); }
    catch (error) { if (!activate && error instanceof StoreSchemaVersionError) return null; throw error; }
  };
  if (command === 'mcp') {
    const provider = host();
    const instance = await startMcp(provider === 'devin' ? openStore : openStore(true)!, provider, codexCommand, {legacy: Boolean(values['legacy-tools'])});
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { instance.detach(); } catch { /* Unattached connections own no peer. */ }
      currentStore?.close();
    };
    instance.server.server.onclose = cleanup;
    const stop = () => { cleanup(); void instance.server.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('exit', cleanup);
    return;
  }
  const nativeCommand = ['connect', 'sessions', 'status-update', 'message-send', 'messages-read'].includes(command)
    || (command === 'disconnect' && option('target') !== undefined);
  const devinCommand = nativeCommand && option('host') === 'devin';
  if (devinCommand) {
    const nativeId = option('session-id');
    if (!nativeId) throw new Error('Fresh native session context is unavailable. Supply this invocation’s native session ID.');
    canonicalSessionId('devin', nativeId);
  }
  const store = openStore(!devinCommand || command === 'connect');
  if (!store) {
    if (command !== 'sessions') throw new Error('Activation required: connect this session before using its inbox.');
    print({self: null, activationRequired: true, sessions: [], nextCursor: null});
    return;
  }
  try {
    if (nativeCommand) {
      const provider = host();
      const nativeId = provider === 'codex' ? process.env.CODEX_THREAD_ID ?? option('session-id') : option('session-id');
      const sessions = new Sessions(store, provider, nativeId, codexCommand);
      switch (command) {
        case 'connect': print(await sessions.connect(required('target'))); break;
        case 'sessions': print(sessions.list({limit: option('limit') === undefined ? undefined : Number(option('limit')), cursor: option('cursor')})); break;
        case 'status-update': print(sessions.updateStatus(required('text'))); break;
        case 'message-send': print(await sessions.send({sessionId: required('target'), text: body(), idempotencyKey: required('key'), replyTo: option('reply-to'), expectsReply: values.notice ? false : undefined})); break;
        case 'messages-read': {
          const limit = option('limit') === undefined ? undefined : Number(option('limit'));
          const notificationToken = option('notification-token');
          if (notificationToken !== undefined && (option('message') !== undefined || option('cursor') !== undefined)) throw new Error('A notification read uses its own bounded batch; omit --message and --cursor.');
          print(notificationToken !== undefined ? await sessions.readNotification(required('notification-token'), limit)
            : sessions.read({messageId: option('message'), limit, cursor: option('cursor'), unreadOnly: Boolean(values['unread-only'])}));
          break;
        }
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
