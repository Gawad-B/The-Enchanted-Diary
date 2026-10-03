import { useEffect, useId, useRef, useState } from 'react';
import { useStrings } from '../../i18n/useStrings';
import { confirmStore, type ConfirmRequest } from '../../state/confirmStore';
import { ClearConversationItem } from '../diary/ClearConversation';

/**
 * The diary menu: offer another manuscript, close this diary, start a new session. Each one only ASKS (a confirmation
 * dialog follows); nothing here changes anything by itself. A real disclosure: the button says it opens a menu, the items
 * are menu items, the arrow keys, Home and End move between them, Escape closes and gives the focus back to the button.
 */
export function DiaryMenu() {
  const { t } = useStrings();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const items: { label: string; request: ConfirmRequest }[] = [
    { label: t.invitation.offerAnother, request: { kind: 'offerAnother' } },
    { label: t.invitation.closeDiary, request: { kind: 'close' } },
    { label: t.invitation.startNewSession, request: { kind: 'reset' } },
  ];

  useEffect(() => {
    if (!open) return undefined;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && !list.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
    };
  }, [open]);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const entries = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const focus = (index: number): void => {
      entries[(index + entries.length) % entries.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focus(at + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focus(at - 1);
        break;
      case 'Home':
        event.preventDefault();
        focus(0);
        break;
      case 'End':
        event.preventDefault();
        focus(entries.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className="reader-bar__menu">
      <button
        type="button"
        ref={button}
        className="reader-bar__button"
        data-diary-menu
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true" className="reader-bar__glyph">
          ⋯
        </span>
        <span className="visually-hidden">{t.reader.menu}</span>
      </button>
      {open && (
        <div
          className="reader-popover reader-popover--menu"
          role="menu"
          id={menuId}
          ref={list}
          tabIndex={-1}
          aria-label={t.reader.menu}
          onKeyDown={onKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.request.kind}
              type="button"
              role="menuitem"
              className="reader-popover__item"
              onClick={() => {
                // The focus goes back to the menu button BEFORE the question is asked: it is what the dialog gives the focus
                // back to (this item is about to leave the page).
                close(true);
                confirmStore.getState().ask(item.request);
              }}
            >
              {item.label}
            </button>
          ))}
          {/* Task 7: the conversation can be cleared from here; it asks once, in place. */}
          <ClearConversationItem
            onDone={() => {
              close(true);
            }}
          />
        </div>
      )}
    </div>
  );
}
