import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface WorkerEntry {
  url: URL;
  execArgv: string[];
}

/**
 * Where the ingestion worker thread starts. A built server has the compiled `worker.js` beside this file; from
 * TypeScript sources (tsx, Vitest) there is only `worker.ts`, which a small bootstrap loads through tsx. The
 * `source` export condition makes `@enchanted/shared` resolve to its sources as it does everywhere in development.
 */
export function resolveWorkerEntry(): WorkerEntry {
  const compiled = new URL('./worker.js', import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return { url: compiled, execArgv: [] };
  return { url: new URL('./worker-bootstrap.mjs', import.meta.url), execArgv: ['--conditions=source'] };
}
