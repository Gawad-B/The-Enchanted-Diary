import { STRINGS, type Language } from '../i18n/strings';
import { leadLength } from '../motion/ink';
import type { ChatState } from '../state/chatStore';
import { pairMessages, type Turn } from '../state/chatTurn';
import { chipsOf, consultedChips, type Chip } from '../ui/diary/citations';
import { displayText, parseAnswer, plainText } from '../ui/diary/format';
import { buildInkDoc, leadUnitCount, type InkDoc } from '../ui/diary/inkDoc';
import { detectLang, scriptLanguage } from '../ui/diary/language';
import type { ExchangeInput } from './layout';
import type { FaceSet } from './typography';

/*
 * The diary's conversation as the page needs it: for every exchange, its question, its answer as pieces of ink (the diary's own
 * words for a refusal, in the script of the question), the sources as notes, and what it needs to keep free after it. The
 * diary's own lines follow the script of the question (global sections I and T): an Arabic question is answered and annotated in
 * Arabic whatever the interface language is.
 */

export interface DiaryExchange extends ExchangeInput {
  /** The sources, with the passage to highlight, by note key. */
  chips: readonly Chip[];
  /** The answer as plain text (what a reader would copy). */
  plain: string;
  /** The script language the exchange is written in. */
  language: Language;
  /** True for the exchange that is still being written (or is the latest one): fresh ink, until the next question. */
  current: boolean;
  /** The question could not be answered: the failure notice goes in the tail. */
  failed: boolean;
}

/** The face set a text is written with: Arabic faces for Arabic script (and Persian, Urdu), the Latin ones for the rest. */
export function faceSetOf(text: string): FaceSet {
  const language = detectLang(text);
  return language === 'ar' || language === 'fa' || language === 'ur' ? 'arabic' : 'latin';
}

/** The one link under an answer: "Show me the truth", in the language of the exchange. */
function truthNote(language: Language): { key: string; label: string; kind: 'cited' } {
  return { key: TRUTH_KEY, label: STRINGS[language].diary.showTruth, kind: 'cited' };
}

export const TRUTH_KEY = 'truth';

function docOf(text: string, streaming: boolean): { doc: InkDoc; plain: string } {
  const paragraphs = parseAnswer(displayText(text, streaming), streaming);
  return { doc: buildInkDoc(paragraphs), plain: plainText(paragraphs) };
}

/** The answer's text with the diary's own remarks after it (the ink ran out; it is not certain), each a paragraph of its own. */
function withNotes(
  text: string,
  extra: readonly string[],
  streaming: boolean,
): { doc: InkDoc; plain: string } {
  if (extra.length === 0) return docOf(text, streaming);
  const joined = [text.trim(), ...extra].filter((part) => part !== '').join('\n\n');
  return docOf(joined, streaming);
}

function historyExchange(
  question: { id: string; content: string },
  answer: {
    content: string;
    mode?: string;
    grounded?: boolean;
    truncated?: boolean;
    citations: Parameters<typeof chipsOf>[0];
  } | null,
  ui: Language,
): DiaryExchange {
  const language = scriptLanguage(question.content, ui);
  const own = STRINGS[language].ask;
  const mode = answer?.mode ?? 'answer';
  let doc: InkDoc | null = null;
  let plain = '';
  let chips: Chip[] = [];
  if (answer) {
    const text = mode === 'not_found' ? own.notFound : mode === 'passages' ? own.passages : answer.content;
    const extra = answer.truncated === true ? [own.truncated] : [];
    ({ doc, plain } = withNotes(text, extra, false));
    chips = mode === 'not_found' ? [] : chipsOf(answer.citations);
  }
  return {
    id: question.id,
    question: question.content,
    answer: doc,
    leadUnits: doc ? leadUnitCount(doc, leadLength(plain)) : 0,
    questionFaces: faceSetOf(question.content),
    answerFaces: plain === '' ? faceSetOf(question.content) : faceSetOf(plain),
    notes: answer && mode !== 'not_found' ? [truthNote(language)] : [],
    noteFaces: language === 'ar' ? 'arabic' : 'latin',
    chips,
    plain,
    language,
    current: false,
    failed: false,
  };
}

/** Rows kept free for a notice that an answer could not come (its line, the technical line, the way to ask again). */
export const NOTICE_ROWS = 4;
/** Rows kept free for the line that says the diary is listening and the real figures of its search. */
export const LISTENING_ROWS = 2;

function currentExchange(turn: Turn, ui: Language): DiaryExchange {
  const language = scriptLanguage(turn.question, ui);
  const own = STRINGS[language].ask;
  const mode = turn.done?.mode ?? 'answer';
  const settled = turn.status === 'done';
  const failed = turn.status === 'failed';
  // A refusal and the list of pages have no tokens: their text is there when the answer is, in the diary's own words.
  const text =
    turn.localText ?? (mode === 'passages' ? own.passages : mode === 'not_found' ? own.notFound : turn.text);
  const streaming = !settled && !failed && mode === 'answer';
  const cited = chipsOf(turn.citations);
  let chips: Chip[] = [];
  if (mode === 'passages') chips = cited;
  else if (mode === 'answer') {
    if (cited.length > 0) chips = cited;
    else if (settled && turn.done?.grounded !== true) chips = consultedChips(turn.consulted, []);
  }
  const blocked = turn.error?.code === 'OUTPUT_BLOCKED';
  const notCertain =
    settled && mode === 'answer' && turn.done?.grounded !== true && turn.citationsReceived && !blocked;
  const extra = [
    ...(settled && turn.done?.truncated === true ? [own.truncated] : []),
    ...(notCertain ? [own.notCertain] : []),
  ];
  const hasText = !turn.hidden && text.trim() !== '';
  const body = hasText ? withNotes(text, extra, streaming) : null;
  const plain = body?.plain ?? '';
  const waiting = !failed && !hasText;
  return {
    id: turn.id,
    question: turn.question,
    answer: body ? body.doc : null,
    leadUnits: body ? leadUnitCount(body.doc, leadLength(plain)) : 0,
    questionFaces: faceSetOf(turn.question),
    answerFaces: plain === '' ? faceSetOf(turn.question) : faceSetOf(plain),
    // The sources are laid out as soon as they are known; the page shows them when the pen has finished.
    notes: settled && mode !== 'not_found' ? [truthNote(language)] : [],
    noteFaces: language === 'ar' ? 'arabic' : 'latin',
    noticeRows: failed ? NOTICE_ROWS : settled && turn.error ? 1 : 0,
    listeningRows: waiting ? LISTENING_ROWS : 0,
    chips: turn.citationsReceived || settled ? chips : [],
    plain,
    language,
    current: true,
    failed,
  };
}

/** The exchanges of the conversation, oldest first, the one being written last. */
export function exchangesOf(chat: Pick<ChatState, 'messages' | 'turn'>, ui: Language): DiaryExchange[] {
  const exchanges: DiaryExchange[] = pairMessages(chat.messages).map(({ question, answer }) =>
    historyExchange(question, answer, ui),
  );
  if (chat.turn) exchanges.push(currentExchange(chat.turn, ui));
  return exchanges;
}
