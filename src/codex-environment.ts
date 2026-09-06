import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function codexEnvironment(base: NodeJS.ProcessEnv = process.env) {
  const override = base.SESSION_BRIDGE_CODEX_HOME;
  if (override !== undefined && (!isAbsolute(override) || override.includes('\0'))) {
    throw new Error('SESSION_BRIDGE_CODEX_HOME must be an absolute path; no queue command was launched.');
  }
  const env = override === undefined ? base : {...base, CODEX_HOME: override};
  return {
    env,
    routing: {
      home: env.CODEX_HOME?.trim() || join(env.HOME || homedir(), '.codex'),
      homeSource: override !== undefined ? 'bridge_override' : env.CODEX_HOME?.trim() ? 'inherited' : 'default',
      sqliteHomeOverride: env.CODEX_SQLITE_HOME?.trim() || null,
    },
  };
}
