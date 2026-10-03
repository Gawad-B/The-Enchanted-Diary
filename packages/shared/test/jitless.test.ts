import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Counts `new Function(...)` calls made while `run` executes. */
async function countFunctionConstructions(run: () => Promise<void>): Promise<number> {
  let count = 0;
  const RealFunction = Function;
  vi.stubGlobal(
    'Function',
    new Proxy(RealFunction, {
      construct(target, args: unknown[]) {
        count += 1;
        return Reflect.construct(target, args) as object;
      },
    }),
  );
  await run();
  return count;
}

describe('zod configuration', () => {
  it('keeps every schema from probing for eval, which a production CSP would report as a violation', async () => {
    const probes = await countFunctionConstructions(async () => {
      // Importing the package builds every schema; parsing exercises the validators.
      const shared = await import('../src/index.js');
      expect(shared.AskRequestSchema.parse({ question: ' hello ' }).question).toBe('hello');
      expect(shared.DocumentDetailSchema.safeParse({}).success).toBe(false);
      expect(shared.AnswerStreamEventSchema.safeParse({ type: 'token', text: 'x' }).success).toBe(true);
    });
    expect(probes).toBe(0);
  });

  it('re-exports the configured z, so other packages build their schemas with it', async () => {
    const shared = await import('../src/index.js');
    const { z } = await import('zod');
    expect(shared.z).toBe(z);
    expect(z.config().jitless).toBe(true);
  });
});
