import { createRequire } from 'node:module';
import type { FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';

/** Fastify's logger option in its object form (the pino options plus Fastify's serializers). */
export type LoggerOptions = Extract<NonNullable<FastifyServerOptions['logger']>, object>;

/** pino-pretty is a dev dependency: a production-only install does not have it. */
export function isPrettyLoggingAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Pino options for Fastify. Credentials are redacted everywhere they could be logged. Question text is only
 * ever logged at debug level (see the ask route), never by the request serializer. Readable one-line logs
 * only in development and only when pino-pretty is installed; everywhere else (production, tests, an install
 * without dev dependencies) the logs are JSON lines.
 */
export function buildLoggerOptions(
  config: Config,
  prettyAvailable: boolean = isPrettyLoggingAvailable(),
): LoggerOptions {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
    ...(config.nodeEnv === 'development' && prettyAvailable
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}
