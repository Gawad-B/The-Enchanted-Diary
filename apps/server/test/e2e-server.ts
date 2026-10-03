/*
 * The server of the deterministic end-to-end tests (Playwright journeys, global section K):
 *
 *     npx tsx --conditions=source apps/server/test/e2e-server.ts
 *
 * It is the real server (`buildApp` with the configuration from the environment): upload, validation, ingestion in
 * worker threads, OCR, hybrid retrieval, the evidence gate, the grounding check, citation validation, the output guard
 * and persistence are all real. Two things are stand-ins, so that a journey needs no Gemini key, no network and no quota:
 *   - the models: `ScriptedLlm` writes the replies (answers, the follow-up rewrite, the grounding verdict) and
 *     `FakeEmbeddings` (hashed character trigrams) embeds chunks and questions; the evidence gate uses
 *     the thresholds measured for that stand-in (`STAND_IN_THRESHOLDS`), not Gemini's. The health and config routes
 *     report them under their own names (`scripted`, `fake`), and the free-tier notice is off (GEMINI_FREE_TIER=false:
 *     nothing leaves the machine).
 *
 * What the scripted model does:
 *   - answer: quotes the first sentence of the first excerpt it was shown and cites that excerpt: `The document
 *     states: "..." [S1]`, and for an Arabic question `يذكر المستند: «...» [S1]` (the framing is in the language of the
 *     question: no English in the Arabic experience, global T.2; the quoted sentence is the document's own words).
 *     Because the excerpts come from real retrieval, the cited page is the page that retrieval ranked first;
 *   - model refusal: a question that matches NOT_FOUND_QUESTIONS gets the sentinel NOT_IN_DOCUMENT (a question that
 *     has words in common with the document, so the evidence gate lets it through: `refusedBy: 'model'`);
 *   - grounding refusal: a question that matches UNGROUNDED_QUESTIONS gets a "no" from the grounding check
 *     (`refusedBy: 'grounding'`); a question about something the document never mentions is stopped by the real evidence
 *     gate before any model is asked (`refusedBy: 'evidence'`);
 *   - follow-ups: the rewrite returns the question as asked;
 *   - reveal: a memory of the excerpts it was shown, with cited key points, framed in the language it is asked to write in
 *     (`Memory: "..."`, `أتذكّر: «...»`);
 *   - a question containing `[slow]` is answered a few characters at a time, 150 ms apart (for journeys that look at
 *     the stream while it is running).
 * This file lives under test/: nothing in src/ may import it.
 */
import { buildApp } from '../src/app.js';
import { ConfigError, type Config } from '../src/config.js';
import { loadConfigFromEnvironment } from '../src/env-file.js';
import { E2E_RULES } from './doubles/e2e-rules.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { ScriptedLlm } from './doubles/scripted-llm.js';
import { STAND_IN_THRESHOLDS } from './doubles/stand-in-thresholds.js';

function readConfig(): Config {
  try {
    return loadConfigFromEnvironment();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

// The stand-ins send nothing to Gemini, so the free-tier notice (the UI's disclosure about a free key) is off whatever the
// environment says, and the health and config routes name the stand-ins ('scripted', 'fake'), not a provider that is not used.
const config: Config = { ...readConfig(), geminiFreeTier: false };
const llm = new ScriptedLlm(E2E_RULES, { chunkChars: 24 });

const app = await buildApp(config, {
  llm,
  ingestion: { embeddings: new FakeEmbeddings() },
  rag: { evidence: STAND_IN_THRESHOLDS },
});
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 10_000).unref();
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
  app.ingestion.startBackground();
} catch (error) {
  app.log.error({ err: error }, 'could not start the end-to-end server');
  await app.close();
  process.exit(1);
}
