import { useEffect, useId, useRef } from 'react';
import { FormattedText } from '../../i18n/FormattedText';
import { useStrings } from '../../i18n/useStrings';
import { experienceStore, useExperienceStore } from '../../state/experience';
import { onUiRequest } from '../../state/uiRequests';
import { useUploadNotice, uploadNoticeStore } from '../../state/uploadNotice';
import { flyleafZone, useAnchoredBox } from './anchoring';
import { FreeTierNotice } from './FreeTierNotice';
import { InWorldError } from './InWorldError';
import { offerFile } from '../../state/offerFile';
import { useFileDrop } from './useFileDrop';

/**
 * The upload ritual's DOM layer. The invitation itself is drawn on the flyleaf by the scene; this component gives it its
 * controls: over the flyleaf while the diary waits (`awaiting`), a real <button> "Choose a manuscript" that opens a hidden
 * file input, a quieter "Read the sample manuscript", and the in-world error of a failed or refused offer (inside the
 * paper: see FLYLEAF_ZONE). The free-tier notice is in front of the reader whichever way an offer begins (FreeTierNotice).
 * Everywhere in the stage a file can be dropped (the book glows and a hint shows where it takes one); a drop is always
 * kept from the browser, whatever the phase (useFileDrop), and the diary decides what to do with it (offerFile). The
 * flyleaf itself, clicked in the 3D scene, asks for the same file picker (the `choose-manuscript` request).
 */
export function UploadPortal() {
  const { t } = useStrings();
  const phase = useExperienceStore((state) => state.phase);
  const error = useExperienceStore((state) => state.error);
  const sessionChecked = useExperienceStore((state) => state.sessionChecked);
  const notice = useUploadNotice((state) => state.notice);
  const input = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const describedBy = useId();
  const acceptsFiles =
    sessionChecked &&
    ['discovery', 'opening', 'awaiting', 'uploading', 'reading', 'manuscript', 'memory'].includes(phase);
  const { dragging } = useFileDrop(acceptsFiles);
  // Never before the session has been looked at: the first frames of the page show the welcome screen and nothing of the upload.
  const awaiting = phase === 'awaiting' && sessionChecked;
  const box = useAnchoredBox<HTMLDivElement>(flyleafZone, awaiting);

  const openPicker = (): void => {
    input.current?.click();
  };

  // The flyleaf, clicked in the scene, asks for the picker too.
  useEffect(
    () =>
      onUiRequest('choose-manuscript', () => {
        if (experienceStore.getState().phase === 'awaiting') openPicker();
      }),
    [],
  );

  // The cover has opened onto the flyleaf: the first thing to reach is its button.
  useEffect(() => {
    if (awaiting) choose.current?.focus({ preventScroll: true });
  }, [awaiting]);

  // A notice belongs to the moment it was made: it goes with the next change of phase.
  useEffect(() => {
    uploadNoticeStore.getState().clear();
  }, [phase]);

  const noticeLine =
    notice?.kind === 'stillReading' ? (
      <p className="upload-portal__hint" role="status">
        {t.hints.stillReading}
        {notice.fileName !== '' && (
          <>
            {' '}
            <FormattedText
              template={t.upload.stillReadingFile}
              values={{ name: <bdi>{notice.fileName}</bdi> }}
            />
          </>
        )}
      </p>
    ) : notice?.kind === 'busy' ? (
      <p className="upload-portal__hint" role="status">
        {t.hints.bookBusy}
      </p>
    ) : notice?.kind === 'rejected' ? (
      <InWorldError error={notice.error} />
    ) : null;

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ''; // the same file may be offered again
          if (file) void offerFile(file);
        }}
      />
      {awaiting && (
        <div className="upload-portal" ref={box} data-testid="upload-portal" data-placed="false">
          {/* The page the book stops on is a plain one in the middle: it says what it is for. */}
          <p className="upload-portal__title">{t.invitation.placeDocument}</p>
          {/* A notice is newer than the error that was on the page when the file was offered: it takes its place. */}
          {(error !== null || noticeLine !== null) && (
            // What the diary says can be longer than the band it has: it scrolls there (and can be reached by keyboard), while
            // the button and the sample link below stay where they are.
            <div
              className="upload-portal__messages"
              // a scrollable region must be focusable, or a keyboard cannot scroll it
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              role="group"
              aria-label={t.upload.messagesLabel}
            >
              {error && noticeLine === null && <InWorldError error={error} />}
              {noticeLine}
            </div>
          )}
          <p className="visually-hidden" id={describedBy}>
            {t.upload.dropSurface}
          </p>
          <button
            type="button"
            ref={choose}
            className="button upload-portal__choose"
            aria-describedby={describedBy}
            onClick={openPicker}
          >
            {t.invitation.choose}
          </button>
        </div>
      )}
      {!awaiting && notice && <div className="upload-portal__floating">{noticeLine}</div>}
      <FreeTierNotice />
      {!awaiting && error && phase === 'discovery' && (
        <div className="upload-portal__floating">
          <InWorldError error={error} />
        </div>
      )}
      {dragging && (
        <p className="drop-hint" role="status" aria-live="polite" data-testid="drop-hint">
          {t.upload.dropHint}
        </p>
      )}
    </>
  );
}
