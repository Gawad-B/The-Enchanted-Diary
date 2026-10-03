import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError, REPO_ROOT, loadConfig, type Config } from './config.js';

/** `<repository root>/.env`, loaded when present. */
export const DEFAULT_ENV_FILE = path.join(REPO_ROOT, '.env');

/**
 * The dotenv file to load, or null for none. `ENV_FILE` (itself read from the real environment, since it
 * cannot live in the file it names) selects another file, relative to the repository root; set it empty to
 * load nothing, which keeps tests and CI independent of a developer's own `.env`.
 */
export function resolveEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.ENV_FILE;
  if (configured === undefined) return DEFAULT_ENV_FILE;
  return configured.trim() === '' ? null : path.resolve(REPO_ROOT, configured.trim());
}

/**
 * Copies the variables of a dotenv file into `env`. A variable that is already set, even to an empty string,
 * is never overridden: the real environment always wins over the file. Returns the names it set.
 */
export function applyEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[name] === undefined) {
      env[name] = value;
      applied.push(name);
    }
  }
  return applied;
}

/**
 * What every entry point (server, migrations, model prefetching) calls instead of `loadConfig`: it loads the
 * dotenv file first, then parses the environment. A missing default `.env` is normal; an `ENV_FILE` that
 * points at nothing is a mistake and is reported as one.
 */
export function loadConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): Config {
  const file = resolveEnvFile(env);
  if (file !== null) {
    if (existsSync(file)) {
      applyEnvFile(file, env);
    } else if (file !== DEFAULT_ENV_FILE) {
      throw new ConfigError([{ variable: 'ENV_FILE', message: `file not found: ${file}` }]);
    }
  }
  return loadConfig(env);
}
