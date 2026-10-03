import { DAILY_QUOTA_DETAIL } from '../../gemini/index.js';
import { documentsRepo } from '../../db/repositories/documents.js';
import { embeddingsRepo } from '../../db/repositories/embeddings.js';
import { ingestJobsRepo } from '../../db/repositories/ingest-jobs.js';
import { stageDataRepo } from '../../db/repositories/ingest-stage.js';
import { EmbeddingError } from '../../embeddings/provider.js';
import { AppError } from '../../http/errors.js';
import { DETAIL_RATE_LIMITED } from '../detail.js';
import { AGAIN, LeaseLostError, TransientTickError, type StepResult, type TickContext } from './context.js';

/** A rate limit (not the daily quota) that keeps answering after the provider's own retries: the client comes back later. */
const RATE_LIMIT_RETRY_MS = 20_000;
/** Ticks in a row that ended on such a limit before the document is given up on. */
const MAX_RATE_LIMITED_TICKS = 5;
/** What a client waits when the embedding service did not answer within the time the tick had left. */
const SLOW_SERVICE_RETRY_MS = 5000;
/** Ticks in a row in which the embedding service did not answer in time before the document is given up on. */
const MAX_SLOW_TICKS = 3;

/**
 * Embeds the next batch of chunks that have no embedding yet, stores it, and repeats until the tick is out of time. What is
 * still to embed is what the database lacks, so a tick repeated after a crash has no cursor to get wrong. When every chunk
 * has its embedding the document is ready.
 */
export async function embedStep(ctx: TickContext): Promise<StepResult> {
  const analysis = ctx.cursor.analysis;
  if (analysis === undefined) throw new Error('the embedding stage has no analysis');
  const { deps, row } = ctx;
  const { embeddings } = deps;

  const next = await embeddingsRepo.nextUnembedded(
    deps.db,
    row.id,
    embeddings.model,
    deps.config.embeddingBatchSize,
  );
  const done = await embeddingsRepo.count(deps.db, row.id);
  const progress = (completed: number): { completed: number; total: number; unit: 'chunks' } => ({
    completed,
    total: analysis.chunkCount,
    unit: 'chunks',
  });
  if (next.length === 0) return finishDocument(ctx, done);

  const reservation = await deps.budgets.reserve('embed', next.length);
  if (!reservation.allowed) return ctx.park(progress(done), DAILY_QUOTA_DETAIL);

  let vectors: number[][];
  // The call (the provider's own retries included) may take what is left of the tick before its hard limit; a call that
  // outlasts it is stopped here, the batch stays unembedded, and the next tick takes it again.
  const unit = ctx.cappedSignal();
  try {
    // Passages are embedded with a title (gemini-embedding-2 takes `title: ... | text: ...`): the section the passage is in,
    // or the name of the document when it is in none.
    vectors = await embeddings.embedPassages(
      next.map((chunk) => chunk.content),
      unit.signal,
      { titles: next.map((chunk) => chunk.sectionTitle ?? row.filename) },
    );
  } catch (error) {
    if (unit.capped()) {
      throw new TransientTickError('the embedding service did not answer within the tick', {
        retryAfterMs: SLOW_SERVICE_RETRY_MS,
        limit: MAX_SLOW_TICKS,
        failure: new AppError(
          'EMBEDDING_FAILED',
          'The embedding service did not answer in time; upload the document again in a while.',
        ),
        kind: 'embedding-slow',
        cause: error,
      });
    }
    if (!(error instanceof EmbeddingError)) throw error;
    if (error.dailyQuota) {
      // The service refused: nothing of what was reserved was used.
      await deps.budgets.refund('embed', next.length, reservation.windowStart);
      return await ctx.park(progress(done), DAILY_QUOTA_DETAIL);
    }
    if (!error.rateLimited) throw error;
    await deps.budgets.refund('embed', next.length, reservation.windowStart);
    throw new TransientTickError('the embedding service is rate limiting', {
      retryAfterMs: RATE_LIMIT_RETRY_MS,
      limit: MAX_RATE_LIMITED_TICKS,
      failure: new AppError(
        'RATE_LIMITED',
        'The embedding service keeps refusing requests; upload the document again in a while.',
        DETAIL_RATE_LIMITED,
      ),
      kind: 'embedding-rate-limit',
      // The service named a pause (about 20 s) and the next tick waits that long, every time.
      backoff: 1,
      cause: error,
    });
  } finally {
    unit.done();
  }
  if (vectors.length !== next.length) {
    throw new AppError('EMBEDDING_FAILED', 'The embedding step returned the wrong number of vectors.');
  }

  await ctx.commit({
    progress: progress(done + next.length),
    writes: (tx) =>
      embeddingsRepo.insertMany(
        tx,
        next.map((chunk, index) => ({
          chunkId: chunk.id,
          model: embeddings.model,
          embedding: vectors[index] ?? [],
        })),
        { onConflictKeep: true },
      ),
  });
  return AGAIN;
}

/** Every chunk has its embedding: the document is ready (one transaction, which also ends the job). */
export async function finishDocument(ctx: TickContext, embedded: number): Promise<StepResult> {
  const analysis = ctx.cursor.analysis;
  if (analysis === undefined) throw new Error('the embedding stage has no analysis');
  const { deps, row } = ctx;
  if (embedded !== analysis.chunkCount) {
    throw new AppError('EMBEDDING_FAILED', 'The embedding step returned the wrong number of vectors.');
  }
  await deps.db.transaction(async (tx) => {
    // The document row first, the job row second (see TickContext.commit).
    const ready = await documentsRepo.markReady(tx, row.id, {
      primaryLanguage: analysis.primaryLanguage,
      direction: analysis.direction,
      languages: analysis.languages,
      sections: analysis.sections,
      warnings: analysis.warnings,
      pageCount: analysis.pageCount,
    });
    if (!ready) throw new LeaseLostError(); // the document was removed meanwhile: nothing to finish
    if (!(await ingestJobsRepo.renew(tx, row.id, ctx.leaseId, deps.config.ingestLeaseMs)))
      throw new LeaseLostError();
    await stageDataRepo.clear(tx, row.id);
    await ingestJobsRepo.remove(tx, row.id);
  });
  await deps.bytes.forget(row.id);
  return { kind: 'finished' };
}
