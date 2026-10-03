import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { DETAIL_ARCHIVE_BUSY, DETAIL_ARCHIVE_FULL } from '../ingest/detail.js';
import { AppError } from './errors.js';
import {
  perIpRateLimit,
  perSessionRateLimit,
  refundIpLimit,
  refundSessionLimit,
  type RateLimitSpec,
} from './rate-limits.js';

/*
 * The hourly upload allowances of a visitor (per session and per address), shared by the two ways a file arrives: the ticket
 * (Blob mode) and the multipart upload. They count ATTEMPTS to upload, but not the ones the archive turned away for its own
 * reasons (the line is full, the day's Blob budget is spent): those are given back, or three visitors behind one address would
 * spend the address's hour on refusals and be locked out when the archive had room again.
 */

export interface UploadLimits {
  ip: ReturnType<typeof perIpRateLimit>;
  session: ReturnType<typeof perSessionRateLimit>;
  /**
   * Runs `work` (the part of an upload that the archive may refuse); when it refuses for the archive's own reason, the allowances
   * this request spent are given back, and the refusal goes on.
   */
  refundingRefusals<T>(request: FastifyRequest, work: () => Promise<T>): Promise<T>;
}

/** Whether `error` is the archive saying "not now" (the line is full, or its budget for the day is spent): never the visitor's doing. */
export function isArchiveRefusal(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'RATE_LIMITED' &&
    (error.detail === DETAIL_ARCHIVE_BUSY || error.detail === DETAIL_ARCHIVE_FULL)
  );
}

export function uploadLimits(app: FastifyInstance, config: Config): UploadLimits {
  const ipSpec: RateLimitSpec = { name: 'uploads-ip', max: config.uploadsPerHourPerIp, timeWindow: '1 hour' };
  const sessionSpec: RateLimitSpec = { name: 'uploads', max: config.uploadsPerHour, timeWindow: '1 hour' };
  return {
    ip: perIpRateLimit(app, ipSpec),
    session: perSessionRateLimit(app, sessionSpec),
    async refundingRefusals(request, work) {
      try {
        return await work();
      } catch (error) {
        if (isArchiveRefusal(error)) {
          await refundIpLimit(app, request, ipSpec).catch(() => undefined);
          await refundSessionLimit(app, request, sessionSpec).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}
