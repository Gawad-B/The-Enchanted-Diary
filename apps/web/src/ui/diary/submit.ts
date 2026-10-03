import { isRevealTrigger } from '@enchanted/shared';
import { exchangesOf } from '../../diarypage/exchanges';
import { STRINGS } from '../../i18n/strings';
import { settingsStore } from '../../state/settingsStore';
import { chatStore, type ChatStore } from '../../state/chatStore';
import { experienceStore, type ExperienceStore } from '../../state/experience';
import { flyleafStore, type FlyleafStore } from './flyleafStore';
import { scriptLanguage } from './language';
import { showTruth } from './showTruth';

export type SubmitResult =
  /** The words were taken: a question started, the reveal was asked for, or the flyleaf answered. */
  | 'sent'
  /** The diary is still writing its last answer: the words stay with the reader. */
  | 'busy'
  /** The diary is not in a state to be written to. */
  | 'ignored';

export interface SubmitDeps {
  experience?: Pick<ExperienceStore, 'getState'>;
  chat?: Pick<ChatStore, 'getState'>;
  flyleaf?: Pick<FlyleafStore, 'getState'>;
  /** Starts the "show me the truth" scene for an answer (the exchange id); the real one by default. */
  showTruth?: (answerId: string) => boolean;
}

/**
 * What happens to the words the reader writes. In the manuscript a reveal phrase is the spoken form of "Show me the truth": it
 * starts that scene for the latest answered exchange (or, with nothing answered yet, the diary says it has nothing to show) and
 * is NEVER sent to the server; anything else is a question. On the
 * flyleaf, before a manuscript, the diary answers in its own scripted voice and nothing is asked of anyone. Components only
 * call this; the network belongs to the ask effect.
 */
export function submitText(text: string, deps: SubmitDeps = {}): SubmitResult {
  const experience = deps.experience ?? experienceStore;
  const chat = deps.chat ?? chatStore;
  const flyleaf = deps.flyleaf ?? flyleafStore;
  const { phase } = experience.getState();
  const secret = isRevealTrigger(text);
  if (phase === 'awaiting') {
    flyleaf.getState().write(text, secret);
    return 'sent';
  }
  if (phase !== 'manuscript') return 'ignored';
  if (secret) {
    const answered = exchangesOf(chat.getState(), settingsStore.getState().uiLanguage).filter(
      (exchange) => !exchange.failed && exchange.notes.length > 0,
    );
    const latest = answered.at(-1);
    if (latest) (deps.showTruth ?? showTruth)(latest.id);
    else {
      // Nothing answered yet: the diary says so, in the script of the words, on the page being written.
      const language = scriptLanguage(text, settingsStore.getState().uiLanguage);
      return chat.getState().sayLocally(text, STRINGS[language].ask.nothingToShow) === null ? 'busy' : 'sent';
    }
    return 'sent';
  }
  return chat.getState().ask(text) === null ? 'busy' : 'sent';
}
