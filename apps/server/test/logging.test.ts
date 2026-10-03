import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildLoggerOptions, isPrettyLoggingAvailable } from '../src/logging.js';
import { testConfig } from './helpers.js';

/** Logs one line through Fastify's logger and returns what was written. */
async function logLine(
  config: ReturnType<typeof testConfig>,
  write: (log: Fastify.FastifyBaseLogger) => void,
): Promise<string> {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  // Fastify's own req/res serializers drop headers before redaction would see them; the identity serializers
  // here make the test exercise the redaction paths themselves, as any custom log statement would.
  // The serializer types only accept Fastify's own objects; the cast lets plain objects through unchanged.
  const identity = ((value: unknown) => value) as never;
  const app = Fastify({
    logger: { ...buildLoggerOptions(config), stream, serializers: { req: identity, res: identity } },
  });
  write(app.log);
  await app.close();
  return output;
}

describe('buildLoggerOptions', () => {
  it('uses the configured level', () => {
    expect(buildLoggerOptions(testConfig({ LOG_LEVEL: 'debug' }))).toMatchObject({ level: 'debug' });
    expect(buildLoggerOptions(testConfig())).toMatchObject({ level: 'silent' });
  });

  it('redacts credentials in request and response headers', async () => {
    const output = await logLine(testConfig({ LOG_LEVEL: 'info' }), (log) => {
      log.info(
        {
          req: {
            headers: {
              authorization: 'Bearer top-secret',
              cookie: 'ed_sid=session-secret',
              'x-api-key': 'key-secret',
              accept: '*/*',
            },
          },
          res: { headers: { 'set-cookie': 'ed_sid=new-session-secret' } },
        },
        'incoming',
      );
    });
    for (const secret of ['top-secret', 'session-secret', 'key-secret', 'new-session-secret']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[redacted]');
    expect(output).toContain('*/*'); // other headers are untouched
  });

  it('falls back to JSON lines when pino-pretty is not installed (a production-only install)', () => {
    expect(buildLoggerOptions(testConfig({ NODE_ENV: 'development' }), false)).not.toHaveProperty(
      'transport',
    );
    expect(buildLoggerOptions(testConfig({ NODE_ENV: 'development' }), true)).toHaveProperty('transport');
    expect(isPrettyLoggingAvailable()).toBe(true); // it is installed here, as a dev dependency
  });

  it('prints readable lines in development only', () => {
    expect(buildLoggerOptions(testConfig({ NODE_ENV: 'development' }))).toHaveProperty(
      'transport.target',
      'pino-pretty',
    );
    expect(buildLoggerOptions(testConfig({ NODE_ENV: 'test' }))).not.toHaveProperty('transport');
    expect(
      buildLoggerOptions(testConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) })),
    ).not.toHaveProperty('transport');
  });

  it('does not log question text at info level', async () => {
    // The ask route (a later task) logs the question at debug; at info the line must not carry it.
    const output = await logLine(testConfig({ LOG_LEVEL: 'info' }), (log) => {
      log.debug({ question: 'who is the founder?' }, 'ask');
      log.info({ questionChars: 19 }, 'ask');
    });
    expect(output).not.toContain('who is the founder');
    expect(output).toContain('"questionChars":19');
  });
});
