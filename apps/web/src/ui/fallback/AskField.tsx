import { useState } from 'react';
import { QUESTION_MAX_CHARS } from '@enchanted/shared';
import { useStrings } from '../../i18n/useStrings';
import { firstStrongDirection } from '../diary/language';
import { submitText } from '../diary/submit';

interface AskFieldProps {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * Where the reader writes: a plain text field in the diary's hand. Enter commits the question (Shift+Enter breaks the line;
 * a key that is part of an IME composition never commits). A question is sent while the diary is not answering another; if it is,
 * the words stay and the diary says so.
 */
export function AskField({ inputRef }: AskFieldProps) {
  const { t, language, direction } = useStrings();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const commit = (): void => {
    const words = text.trim();
    if (words === '') return;
    const result = submitText(words);
    if (result === 'sent') {
      setText('');
      setBusy(false);
    } else if (result === 'busy') {
      setBusy(true);
    }
  };

  return (
    <form
      className="simple-ask"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <label className="visually-hidden" htmlFor="simple-ask-field">
        {t.diary.inputLabel}
      </label>
      <textarea
        id="simple-ask-field"
        ref={inputRef}
        className="simple-ask__field"
        rows={2}
        maxLength={QUESTION_MAX_CHARS}
        lang={language}
        dir={text === '' ? direction : firstStrongDirection(text)}
        placeholder={t.invitation.writePrompt}
        enterKeyHint="send"
        value={text}
        aria-describedby={busy ? 'simple-ask-busy' : undefined}
        onChange={(event) => {
          setText(event.target.value);
          setBusy(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          commit();
        }}
      />
      {busy && (
        <p className="simple-ask__busy" id="simple-ask-busy" role="status">
          {t.ask.diaryStillWriting}
        </p>
      )}
      <button type="submit" className="button simple-ask__send">
        {t.diary.write}
      </button>
    </form>
  );
}
