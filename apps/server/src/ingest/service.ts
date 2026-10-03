import type { Db } from '../db/client.js';
import { retryOnDeadlock } from '../db/errors.js';
import { documentsRepo } from '../db/repositories/documents.js';
import type { StorageProvider } from '../storage/provider.js';
import type { DocumentBytes } from './bytes.js';
import type { TickRunner } from './tick/runner.js';

export interface ServiceDeps {
  db: Db;
  storage: StorageProvider;
  runner: TickRunner;
  bytes: DocumentBytes;
  log: { warn(object: object, message: string): void };
}

/** A document that has been removed from the database: what is left to clean up. */
export interface RemovedDocument {
  id: string;
  storageKey: string;
}

/**
 * What removing a document means, in one place (DELETE, a replaced upload, session reset, retention): stop its tick if one
 * runs in this process (a tick in another instance finds out at its next save), drop its rows (job, scratch data, pages,
 * chunks and embeddings follow by cascade), and delete its file. The database side retries once when it is chosen as the
 * victim of a deadlock with a tick that is committing (the two take the document row and the job row in the same order, so
 * this is only a safety net).
 */
export class DocumentService {
  constructor(private readonly deps: ServiceDeps) {}

  /** Stops the tick of the document that runs in this process, and waits until it has let go. */
  async cancelJob(documentId: string): Promise<void> {
    await this.deps.runner.cancel(documentId);
  }

  /** True when there was such a document. */
  async removeDocument(documentId: string): Promise<boolean> {
    await this.cancelJob(documentId);
    const removed = await retryOnDeadlock(() => documentsRepo.remove(this.deps.db, documentId));
    if (removed === null) {
      await this.deps.bytes.forget(documentId).catch(() => undefined);
      return false;
    }
    await this.cleanUp({ id: documentId, storageKey: removed.storageKey });
    return true;
  }

  /** Removes every document of the session; returns how many there were. */
  async removeSessionDocuments(sessionId: string): Promise<number> {
    const rows = await documentsRepo.listForSession(this.deps.db, sessionId);
    for (const row of rows) await this.removeDocument(row.id);
    return rows.length;
  }

  /**
   * What is left to do once a document's rows are gone (they were removed in a transaction of the caller's): its tick in this
   * process is stopped, its cached copy forgotten and its file deleted. A file that cannot be deleted is told, not thrown: the
   * retention sweep finds it again.
   */
  async cleanUp(removed: RemovedDocument): Promise<void> {
    await this.cancelJob(removed.id);
    await this.deps.bytes.forget(removed.id).catch(() => undefined);
    await this.deps.storage.delete(removed.storageKey).catch((error: unknown) => {
      this.deps.log.warn(
        { err: error, documentId: removed.id },
        'could not remove the file of a removed document',
      );
    });
  }
}
