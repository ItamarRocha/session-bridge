import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function inspect(command: string, args: string[]) {
  try {
    const { stdout } = await run(command, args, { timeout: 5_000, maxBuffer: 128 * 1024 });
    return { available: true, output: stdout.trim() };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'failed';
    return { available: false, output: code };
  }
}

export async function doctor(home: string, codexCommand = 'codex') {
  const [codex, queue, claude] = await Promise.all([
    inspect(codexCommand, ['--version']), inspect(codexCommand, ['queue', '--help']), inspect('claude', ['--version']),
  ]);
  return {
    node: { version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 24 },
    platform: process.platform,
    stateHome: home,
    codex: { ...codex, queueAvailable: queue.available && /--thread/.test(queue.output) && /--message/.test(queue.output) },
    claude,
    monitorEnvironmentBlocked: ['DISABLE_TELEMETRY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'].filter(key => Boolean(process.env[key])),
    limitations: [
      'Claude plugin monitors are experimental and require a supported interactive CLI host. Version alone does not prove availability.',
      'Codex native queue availability does not prove the target is loaded in the same storage root. Closed tasks remain queued; interruption remains a pause.',
      'This diagnostic reads versions/help only. It does not send a message or test model reception.',
    ],
  };
}
