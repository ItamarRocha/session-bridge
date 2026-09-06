import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codexEnvironment } from './codex-environment.js';

const run = promisify(execFile);

async function inspect(command: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    const { stdout } = await run(command, args, { timeout: 5_000, maxBuffer: 128 * 1024, env });
    return { available: true, output: stdout.trim() };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'failed';
    return { available: false, output: code };
  }
}

export async function doctor(home: string, codexCommand = 'codex', env: NodeJS.ProcessEnv = process.env) {
  const destination = codexEnvironment(env);
  const [codex, queue, claude] = await Promise.all([
    inspect(codexCommand, ['--version'], destination.env), inspect(codexCommand, ['queue', '--help'], destination.env), inspect('claude', ['--version'], env),
  ]);
  return {
    node: { version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 24 },
    platform: process.platform,
    stateHome: home,
    codex: { ...codex, queueAvailable: queue.available && /--thread/.test(queue.output) && /--message/.test(queue.output), routing: destination.routing },
    claude,
    monitorEnvironmentBlocked: ['DISABLE_TELEMETRY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'].filter(key => Boolean(env[key])),
    limitations: [
      'Claude plugin monitors are experimental and require a supported interactive CLI host. Version alone does not prove availability.',
      'Codex native queue availability does not prove the target is loaded in the same storage root. Closed tasks remain queued; interruption remains a pause.',
      'Codex routing reports the child environment, not a verified queue path. Native config sqlite_home overrides CODEX_SQLITE_HOME, which overrides the Codex home for SQLite storage.',
      'This diagnostic reads versions/help only. It does not send a message or test model reception.',
    ],
  };
}
