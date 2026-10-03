import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, REPO_ROOT } from '../src/config.js';
import {
  DEFAULT_ENV_FILE,
  applyEnvFile,
  loadConfigFromEnvironment,
  resolveEnvFile,
} from '../src/env-file.js';

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(REPO_ROOT, '.data', 'tmp', 'env-file-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function envFile(contents: string, name = '.env'): Promise<string> {
  const file = path.join(directory, `${name}-${String(Math.random()).slice(2, 8)}`);
  await writeFile(file, contents);
  return file;
}

describe('applyEnvFile', () => {
  it('parses dotenv syntax: comments, quotes, export, blanks', async () => {
    const file = await envFile(
      [
        '# a comment',
        '',
        'PORT=9123',
        'HOST="0.0.0.0"',
        "LOG_LEVEL='debug'",
        'export MAX_PAGES=7',
        'OCR_LANGUAGES=eng # trailing',
      ].join('\n'),
    );
    const env: NodeJS.ProcessEnv = {};
    expect(applyEnvFile(file, env).sort()).toEqual([
      'HOST',
      'LOG_LEVEL',
      'MAX_PAGES',
      'OCR_LANGUAGES',
      'PORT',
    ]);
    expect(env).toMatchObject({
      PORT: '9123',
      HOST: '0.0.0.0',
      LOG_LEVEL: 'debug',
      MAX_PAGES: '7',
      OCR_LANGUAGES: 'eng',
    });
  });

  it('never overrides a variable that is already set, even to an empty string', async () => {
    const file = await envFile('PORT=1111\nHOST=0.0.0.0\nLOG_LEVEL=debug\n');
    const env: NodeJS.ProcessEnv = { PORT: '2222', LOG_LEVEL: '' };
    expect(applyEnvFile(file, env)).toEqual(['HOST']);
    expect(env).toEqual({ PORT: '2222', LOG_LEVEL: '', HOST: '0.0.0.0' });
  });
});

describe('resolveEnvFile', () => {
  it('defaults to .env at the repository root', () => {
    expect(DEFAULT_ENV_FILE).toBe(path.join(REPO_ROOT, '.env'));
    expect(resolveEnvFile({})).toBe(DEFAULT_ENV_FILE);
  });

  it('honours ENV_FILE (relative paths resolve against the repository root) and an empty one disables loading', () => {
    expect(resolveEnvFile({ ENV_FILE: '/etc/diary.env' })).toBe('/etc/diary.env');
    expect(resolveEnvFile({ ENV_FILE: 'config/local.env' })).toBe(
      path.join(REPO_ROOT, 'config', 'local.env'),
    );
    expect(resolveEnvFile({ ENV_FILE: '' })).toBeNull();
    expect(resolveEnvFile({ ENV_FILE: '   ' })).toBeNull();
  });
});

describe('loadConfigFromEnvironment', () => {
  it('applies the values of the file to the configuration', async () => {
    const file = await envFile('PORT=9123\nMAX_PAGES=7\nLLM_PROVIDER=none\n');
    const config = loadConfigFromEnvironment({ ENV_FILE: file });
    expect(config).toMatchObject({ port: 9123, maxPages: 7, llmProvider: 'none' });
  });

  it('lets real environment variables win over the file', async () => {
    const file = await envFile('PORT=9123\nMAX_PAGES=7\n');
    const config = loadConfigFromEnvironment({ ENV_FILE: file, PORT: '9555' });
    expect(config).toMatchObject({ port: 9555, maxPages: 7 });
  });

  it('reads nothing when ENV_FILE is empty, whatever .env exists', () => {
    const config = loadConfigFromEnvironment({ ENV_FILE: '' });
    expect(config.port).toBe(8787);
  });

  it('reports an invalid value in the file by its variable name', async () => {
    const file = await envFile('PORT=abc\n');
    expect(() => loadConfigFromEnvironment({ ENV_FILE: file })).toThrow(/PORT: must be an integer/);
  });

  it('reports an ENV_FILE that points at nothing, as a configuration error', () => {
    const attempt = () => loadConfigFromEnvironment({ ENV_FILE: path.join(directory, 'does-not-exist.env') });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/ENV_FILE: file not found/);
  });

  // Only meaningful when the repository has no .env of its own (with one, the same call would just load it).
  it.skipIf(existsSync(DEFAULT_ENV_FILE))('treats a missing default .env as normal: nothing to load', () => {
    expect(loadConfigFromEnvironment({}).port).toBe(8787);
  });
});

describe('.env stays out of version control', () => {
  it('is git-ignored while .env.example is not', async () => {
    const ignore = (await readFile(path.join(REPO_ROOT, '.gitignore'), 'utf8'))
      .split('\n')
      .map((line) => line.trim());
    expect(ignore).toContain('.env*');
    expect(ignore).toContain('!.env.example');
  });
});
