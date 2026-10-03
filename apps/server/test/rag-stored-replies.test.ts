import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OutputGuard } from '../src/rag/guard.js';
import { PROCESS_CANARY } from '../src/rag/prompts.js';
import { ReplyProcessor, finalizeReply, splitSentences } from '../src/rag/reply.js';
import { isRefusalReply } from '../src/rag/sentinel.js';
import { questionContext } from '../src/rag/silence.js';
import { arabicReplyLatinFailures, partialAnswerFailures } from './evals/checks.js';

/*
 * Fix round 4, acceptance (c) and (d): the reply rules re-run OFFLINE over every live answer the earlier rounds stored
 * (`.data/task4/evals-*.json`: the raw model reply of each row, the question, the final text the rules of that round made).
 * Nothing here calls a model. The data is local (never committed), so the suite is skipped where it is absent.
 *  - no stored answer turns into a refusal, and no cited sentence is lost (the marker count of the final text is unchanged);
 *  - every gap sentence of a question-3 answer (the half of a partial answer that names the missing qualifier) is kept;
 *  - every stored question-3 answer still passes the checker, as stored and as re-finalised.
 */

const DATA = fileURLToPath(new URL('../../../.data/task4/', import.meta.url));
const FILES = [
  'evals-run1-full.json',
  'evals-final.json',
  'evals-fix1-full.json',
  'evals-fix2-full.json',
  'evals-fix3-round3.json',
];

interface Row {
  id: string;
  question: string;
  lang: string;
  mode: string;
  answer: string;
  citedPages: number[];
  rewrittenQuery: string | null;
  modelReplies?: string[];
}

const present = FILES.every((file) => existsSync(`${DATA}${file}`));
const rows = (): { file: string; row: Row }[] =>
  present
    ? FILES.flatMap((file) =>
        (JSON.parse(readFileSync(`${DATA}${file}`, 'utf8')) as { rows: Row[] }).rows.map((row) => ({
          file,
          row,
        })),
      )
    : [];

const MARKER = /\[S\d{1,3}\]/gu;
/** The eval stores each raw reply with its white space collapsed and cut at 500 characters (rag.eval.test.ts). */
const STORED_RAW_LIMIT = 500;
const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const markerCount = (text: string): number => text.match(MARKER)?.length ?? 0;
const sentencesOfText = (text: string): string[] =>
  text
    .split('\n')
    .flatMap((line) => splitSentences(line))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');

/** The raw replies of the answer model that ended as answers, with the row that asked them. */
const answered = (): { file: string; row: Row; raw: string }[] =>
  rows().flatMap(({ file, row }) =>
    row.mode !== 'answer'
      ? []
      : (row.modelReplies ?? [])
          .filter((reply) => reply.startsWith('answer:'))
          .map((reply) => ({ file, row, raw: reply.slice('answer:'.length).trimStart() })),
  );

describe.skipIf(!present)('the stored live answers, re-finalised offline (acceptance c, d)', () => {
  it('turns none into a refusal and loses no cited sentence', () => {
    const replies = answered();
    expect(replies.length).toBe(81);
    for (const { file, row, raw } of replies) {
      const label = `${file} ${row.id}`;
      const valid = new Set(row.answer.match(MARKER)?.map((marker) => marker.slice(1, -1)) ?? []);
      const final = finalizeReply(raw, valid, questionContext(row.question, row.rewrittenQuery));
      expect(isRefusalReply(raw), label).toBe(false);
      expect(final.notFound, label).toBe(false);
      // every cited sentence of the stored answer that the stored raw reply holds whole is still there
      for (const sentence of sentencesOfText(row.answer)) {
        if (markerCount(sentence) > 0 && squash(raw).includes(squash(sentence))) {
          expect(squash(final.text), label).toContain(squash(sentence));
        }
      }
      if (raw.length < STORED_RAW_LIMIT) expect(markerCount(final.text), label).toBe(markerCount(row.answer));
    }
  });

  it('keeps every gap sentence of a question-3 answer, and every one passes the checker as stored and re-finalised', () => {
    const INTERNATIONAL = /international\s+students?|الدوليين|الدوليون/iu;
    let gaps = 0;
    let checked = 0;
    for (const { file, row, raw } of answered()) {
      if (!row.id.startsWith('Q3')) continue;
      const lang = row.lang === 'ar' ? 'ar' : 'en';
      const label = `${file} ${row.id}`;
      const final = finalizeReply(
        raw,
        new Set(row.answer.match(MARKER)?.map((marker) => marker.slice(1, -1)) ?? []),
        questionContext(row.question, row.rewrittenQuery),
      );
      // a gap sentence: an uncited sentence of the model's reply about the qualifier (flourishes never name it)
      for (const sentence of sentencesOfText(raw)) {
        if (markerCount(sentence) > 0 || !INTERNATIONAL.test(sentence)) continue;
        gaps += 1;
        expect(final.text, label).toContain(sentence);
      }
      expect(partialAnswerFailures(lang, final.text, row.citedPages), label).toEqual([]);
      // the final texts stored by the rounds that dropped uncited sentences (fix 2 on; the reviewer read all 25)
      if (file === 'evals-fix2-full.json' || file === 'evals-fix3-round3.json') {
        checked += 1;
        expect(partialAnswerFailures(lang, row.answer, row.citedPages), label).toEqual([]);
      }
    }
    expect(gaps).toBeGreaterThan(0);
    expect(checked).toBe(25);
  });

  it('streams every stored answer whole, however it is cut into chunks, and refuses none of them', () => {
    const replies = answered();
    for (const { file, row, raw } of replies) {
      const valid = new Set(row.answer.match(MARKER)?.map((marker) => marker.slice(1, -1)) ?? []);
      const streamed = [1, 5, 24, raw.length].map((size) => {
        const processor = new ReplyProcessor(valid, new OutputGuard('You are a diary.', PROCESS_CANARY, []));
        let text = '';
        for (let index = 0; index < raw.length; index += size)
          text += processor.push(raw.slice(index, index + size)).emit;
        text += processor.end();
        expect(processor.startedWithSentinel, `${file} ${row.id}`).toBe(false);
        return text;
      });
      expect(new Set(streamed).size, `${file} ${row.id}`).toBe(1);
      if (raw.length < STORED_RAW_LIMIT) {
        expect(markerCount(streamed[0] ?? ''), `${file} ${row.id}`).toBeGreaterThanOrEqual(
          markerCount(row.answer),
        );
      }
    }
  });

  it('still reads every stored refusal of the model as one', () => {
    const refusals = rows().flatMap(({ row }) =>
      row.mode === 'answer'
        ? []
        : (row.modelReplies ?? [])
            .filter((reply) => reply.startsWith('answer:'))
            .map((reply) => reply.slice('answer:'.length).trimStart()),
    );
    expect(refusals.length).toBeGreaterThan(0);
    for (const raw of refusals) expect(isRefusalReply(raw), raw).toBe(true);
  });

  it('finds English in exactly the Arabic answers that had it (global §T.2)', () => {
    const flagged = rows()
      .filter(({ row }) => row.lang === 'ar' && row.mode === 'answer')
      .filter(({ row }) => arabicReplyLatinFailures(row.answer).length > 0)
      .map(({ file, row }) => `${file} ${row.id}`);
    // the one Arabic question the model answered in English (fix 2, concern 1 of the report)
    expect(flagged).toEqual(['evals-fix2-full.json meta: what is this document about (AR)']);
  });
});
