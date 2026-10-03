import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { nextTestDirectory } from './helpers.js';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

interface Run {
  child: ChildProcess;
  output: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function run(env: Record<string, string>): Run {
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', MAIN], {
    cwd: path.join(REPO_ROOT, 'apps', 'server'),
    // ENV_FILE empty: a developer's own .env must not change what these tests start.
    // The retention sweep starts with the server and deletes files that have no database row: it must never look
    // at the directories of a developer's own server, so every run gets its own storage and scratch directories.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ENV_FILE: '',
      STORAGE_DIR: nextTestDirectory('storage'),
      TMP_DIR: nextTestDirectory('tmp'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let collected = '';
  child.stdout.on('data', (chunk: Buffer) => (collected += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (collected += chunk.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, output: () => collected, exit };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('main', () => {
  it('prints a readable configuration error and exits with code 1', async () => {
    const { exit, output } = run({ NODE_ENV: 'production', PORT: 'abc' });
    const result = await exit;
    expect(result.code).toBe(1);
    expect(output()).toContain('Invalid configuration');
    expect(output()).toContain('PORT');
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'serves requests and shuts down gracefully on %s',
    async (signal) => {
      const port = await freePort();
      const { child, exit, output } = run({
        NODE_ENV: 'test',
        PORT: String(port),
        PGLITE_DATA_DIR: 'memory://',
        LOG_LEVEL: 'info',
      });
      await waitFor(() => output().includes('Server listening'), 'the server to listen');
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { db: string }).db).toBe('pglite');

      child.kill(signal);
      const result = await exit;
      expect(result.code).toBe(0);
      expect(output()).toContain('shutting down');
    },
  );
});

describe('main and .env', () => {
  it('reads its configuration from the file ENV_FILE names, with real environment variables winning', async () => {
    const filePort = await freePort();
    const envPort = await freePort();
    const file = path.join(REPO_ROOT, '.data', 'tmp', `main-env-${String(filePort)}.env`);
    await writeFile(
      file,
      `PORT=${String(filePort)}\nPGLITE_DATA_DIR=memory://\nLOG_LEVEL=info\nNODE_ENV=test\n`,
    );
    try {
      // PORT in the real environment beats PORT in the file; the other settings come from the file alone.
      const { child, exit, output } = run({ ENV_FILE: file, PORT: String(envPort) });
      await waitFor(() => output().includes('Server listening'), 'the server to listen');
      expect(output()).toContain(`:${String(envPort)}`);
      expect((await fetch(`http://127.0.0.1:${String(envPort)}/api/health`)).status).toBe(200);
      child.kill('SIGTERM');
      expect((await exit).code).toBe(0);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('reports a problem in the file as a readable configuration error and exits 1', async () => {
    const file = path.join(REPO_ROOT, '.data', 'tmp', `main-bad-${String(process.pid)}.env`);
    await writeFile(file, 'PORT=not-a-number\n');
    try {
      const { exit, output } = run({ ENV_FILE: file });
      expect((await exit).code).toBe(1);
      expect(output()).toContain('Invalid configuration');
      expect(output()).toContain('PORT');
    } finally {
      await rm(file, { force: true });
    }
  });
});
