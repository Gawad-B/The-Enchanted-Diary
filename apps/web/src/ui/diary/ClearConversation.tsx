import { useEffect, useRef, useState } from 'react';
import { useStrings } from '../../i18n/useStrings';
import { chatStore, useChatStore } from '../../state/chatStore';

/**
 * "Clear the conversation", an entry of the diary menu: the diary forgets what was said (the manuscript stays). It asks once
 * before it does anything, in place: the entry becomes the question with its two answers, and the focus is on the safe one.
 * The entries are `menuitem`s of the menu they are in, so its arrow keys reach them.
 */
export function ClearConversationItem({ onDone }: { onDone: () => void }) {
  const { t } = useStrings();
  const has = useChatStore((state) => state.messages.length > 0 || state.turn !== null);
  const [confirming, setConfirming] = useState(false);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) safe.current?.focus();
  }, [confirming]);
  if (!has) return null;
  if (!confirming) {
    return (
      <button
        type="button"
        role="menuitem"
        className="reader-popover__item"
        data-testid="clear-conversation"
        onClick={() => {
          setConfirming(true);
        }}
      >
        {t.diary.clear}
      </button>
    );
  }
  return (
    <div role="group" aria-label={t.diary.clearAsk} className="clear-ask">
      <p className="clear-ask__text">{t.diary.clearAsk}</p>
      <button
        type="button"
        role="menuitem"
        className="reader-popover__item clear-ask__danger"
        data-testid="clear-confirm"
        onClick={() => {
          chatStore.getState().requestClear();
          onDone();
        }}
      >
        {t.diary.clearConfirm}
      </button>
      <button
        type="button"
        role="menuitem"
        className="reader-popover__item"
        ref={safe}
        onClick={() => {
          setConfirming(false);
          onDone();
        }}
      >
        {t.confirm.cancel}
      </button>
    </div>
  );
}
