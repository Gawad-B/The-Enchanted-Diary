import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_VARIABLES, REPO_ROOT, loadConfig } from '../src/config.js';

const example = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');

/** Variables set in the example file (uncommented lines of the form NAME=value). */
function documentedValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of example.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = match[2] ?? '';
  }
  return values;
}

describe('.env.example', () => {
  it('documents every variable the server reads', () => {
    const mentioned = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
    expect(CONFIG_VARIABLES.filter((name) => !mentioned.has(name))).toEqual([]);
  });

  it('mentions the unused VECTOR_DB_URL from the product spec, commented out', () => {
    expect(example).toMatch(/^# VECTOR_DB_URL=/m);
    expect(documentedValues()).not.toHaveProperty('VECTOR_DB_URL');
  });

  it('lists no variable the server does not read', () => {
    expect(Object.keys(documentedValues()).filter((name) => !CONFIG_VARIABLES.includes(name))).toEqual([]);
  });

  it('shows the real defaults: loading the file as the environment changes nothing', () => {
    const { sessionSecret: documentedSecret, ...documented } = loadConfig(documentedValues());
    const { sessionSecret: defaultSecret, ...defaults } = loadConfig({});
    expect(documented).toEqual(defaults);
    expect(documentedSecret).toHaveLength(64); // the example leaves SESSION_SECRET empty
    expect(defaultSecret).toHaveLength(64);
  });

  it('can be imported as the environment of a Vercel project without a line that is wrong there', () => {
    const values = documentedValues();
    // The lines that would be wrong on Vercel are commented out (their defaults are what the file would say).
    for (const name of ['NODE_ENV', 'TRUST_PROXY', 'STORAGE_PROVIDER', 'MAX_UPLOAD_MB', 'TMP_DIR']) {
      expect(values, name).not.toHaveProperty(name);
    }
    const onVercel = loadConfig({
      ...values,
      VERCEL: '1',
      DATABASE_URL: 'postgres://u:p@ep-x-pooler.neon.tech/db?sslmode=require',
      STORAGE_PROVIDER: 'vercel-blob',
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x',
      SESSION_SECRET: 'x'.repeat(40),
    });
    expect(onVercel).toMatchObject({
      onVercel: true,
      trustProxy: true,
      storageProvider: 'vercel-blob',
      maxUploadMb: 20,
      tmpDir: '/tmp/enchanted-diary',
    });
  });

  it('never contains a real-looking secret', () => {
    const values = documentedValues();
    expect(values.ANTHROPIC_API_KEY).toBe('');
    expect(values.OPENAI_API_KEY).toBe('');
    expect(values.SESSION_SECRET).toBe('');
    expect(values.BLOB_READ_WRITE_TOKEN).toBe('');
    expect(values.CRON_SECRET).toBe('');
    expect(example).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});
