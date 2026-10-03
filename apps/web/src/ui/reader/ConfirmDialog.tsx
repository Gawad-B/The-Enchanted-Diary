import { useEffect, useId, useRef } from 'react';
import { FormattedText } from '../../i18n/FormattedText';
import { useStrings } from '../../i18n/useStrings';
import { carryOut, confirmStore, useConfirmStore, type ConfirmRequest } from '../../state/confirmStore';
import { displayName } from '../../state/validateFile';

/**
 * The confirmation dialog for what cannot be undone. A modal: focus goes to "Not now" (the safe choice), Tab stays inside,
 * Escape and a click on the dim backdrop cancel, and focus returns to what had it when the question was asked (the
 * store keeps that: see `opener`). One host, at the root of the stage and above everything in it; the rest of the stage is
 * inert while a question is up (see ExperienceShell). A new question is a new dialog (keyed by `serial`).
 */
export function ConfirmDialogHost() {
  const request = useConfirmStore((state) => state.request);
  const serial = useConfirmStore((state) => state.serial);
  return request ? <ConfirmDialog key={serial} request={request} /> : null;
}

function copyFor(request: ConfirmRequest, t: ReturnType<typeof useStrings>['t']) {
  switch (request.kind) {
    case 'offerAnother':
      return t.confirm.offerAnother;
    case 'replace':
      return t.confirm.replace;
    case 'close':
      return t.confirm.close;
    case 'reset':
      return t.confirm.reset;
  }
}

function ConfirmDialog({ request }: { request: ConfirmRequest }) {
  const { t } = useStrings();
  const titleId = useId();
  const bodyId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const copy = copyFor(request, t);

  useEffect(() => {
    // Taken when the question was asked, not now: by now the stage behind is inert and the browser has moved the focus away.
    const opener = confirmStore.getState().opener;
    cancel.current?.focus();
    return () => {
      // Back to what asked; failing that (it is gone, or the question came from a dropped file) to the diary menu.
      const home =
        opener?.isConnected === true ? opener : document.querySelector<HTMLElement>('[data-diary-menu]');
      home?.focus();
    };
  }, []);

  const dismiss = (): void => {
    confirmStore.getState().dismiss();
  };
  const accept = (): void => {
    confirmStore.getState().dismiss();
    carryOut(request);
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    // A two-button trap: Tab and Shift+Tab cycle between "Not now" and the confirmation.
    const first = cancel.current;
    const last = confirm.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="confirm"
      role="presentation"
      data-testid="confirm-dialog"
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        className="confirm__sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h2 className="confirm__title" id={titleId}>
          {copy.title}
        </h2>
        <p className="confirm__body" id={bodyId}>
          {request.kind === 'replace' ? (
            <FormattedText
              template={copy.body}
              values={{ name: <bdi>{displayName(request.file.name)}</bdi> }}
            />
          ) : (
            copy.body
          )}
        </p>
        <div className="confirm__actions">
          <button type="button" className="button" ref={cancel} onClick={dismiss}>
            {t.confirm.cancel}
          </button>
          <button type="button" className="button button--danger" ref={confirm} onClick={accept}>
            {copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
