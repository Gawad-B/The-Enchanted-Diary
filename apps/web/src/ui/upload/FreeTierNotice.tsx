import { useStrings } from '../../i18n/useStrings';
import { freeTierNoticeApplies, useConfigStore } from '../../state/configStore';
import { useExperienceStore, type Phase } from '../../state/experience';

/** The phases in which an offer of a file can still be made or is being made: before the first manuscript is bound. */
// Not on the welcome screen (nothing may sit over its button): on the upload page and while the offer is sent and read.
const BEFORE_A_MANUSCRIPT: readonly Phase[] = ['awaiting', 'uploading', 'reading'];

/**
 * The note that the model service is a free tier which may keep what it reads, in front of the reader before ANY upload,
 * whichever way it begins (the button, the sample, a file dropped on the closed book): so it is shown from the first
 * moment the diary can be offered pages (once the session has been looked at), not only on the flyleaf. It is shown when the
 * server says so, and also while the server has not said anything (or could not): the disclosure fails safe, never open.
 */
export function FreeTierNotice() {
  const { t } = useStrings();
  const phase = useExperienceStore((state) => state.phase);
  const sessionChecked = useExperienceStore((state) => state.sessionChecked);
  const applies = useConfigStore(freeTierNoticeApplies);
  if (!applies || !sessionChecked || !BEFORE_A_MANUSCRIPT.includes(phase)) return null;
  return (
    <p className="upload-portal__free-tier" role="status" data-testid="free-tier-notice">
      {t.upload.freeTierNotice}
    </p>
  );
}
