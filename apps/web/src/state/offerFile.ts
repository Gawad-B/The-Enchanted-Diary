import { canAcceptFile, experienceStore, type ExperienceStore } from './experience';
import { configStore, type ConfigStore } from './configStore';
import { uploadNoticeStore, type UploadNoticeStore } from './uploadNotice';
import { confirmStore, type ConfirmStore } from './confirmStore';
import { FALLBACK_MAX_UPLOAD_BYTES, displayName, validateManuscript, type Validation } from './validateFile';

export interface OfferDeps {
  experience?: Pick<ExperienceStore, 'getState'>;
  config?: Pick<ConfigStore, 'getState'>;
  notices?: Pick<UploadNoticeStore, 'getState'>;
  confirm?: Pick<ConfirmStore, 'getState'>;
  validate?: (file: File, limits: { maxBytes: number }) => Promise<Validation>;
}

/**
 * A file the reader chose or dropped, handled by what the diary is doing:
 *  - uploading or reading: "I am still reading" (a line, nothing else changes);
 *  - manuscript or memory: a confirmation first (the diary would forget the manuscript it holds), and only confirming
 *    dispatches REPLACE_REQUESTED{file};
 *  - discovery, opening, awaiting: FILE_SELECTED, which starts the upload (on the closed book it opens the cover first);
 *  - unveiling, revealing, closing: "the diary is turning its pages" (a line; the offer is not kept);
 *  - discovery before the session has been looked at: ignored (the boot check is a second or two).
 * The checks the browser can make (name, type, size, the `%PDF-` mark) happen first, so a wrong file is refused in the
 * diary's voice before anything is sent. Whatever the phase, the browser's own handling of a dropped file (opening it in
 * the tab) is prevented by the drop listener before this is called: this decides only what the DIARY does.
 */
export async function offerFile(file: File, deps: OfferDeps = {}): Promise<void> {
  const experience = deps.experience ?? experienceStore;
  const config = deps.config ?? configStore;
  const notices = deps.notices ?? uploadNoticeStore;
  const confirm = deps.confirm ?? confirmStore;
  const validate = deps.validate ?? validateManuscript;

  const { phase, sessionChecked } = experience.getState();
  const fileName = displayName(file.name);
  if (phase === 'uploading' || phase === 'reading') {
    notices.getState().show({ kind: 'stillReading', fileName });
    return;
  }
  if (phase === 'unveiling' || phase === 'revealing' || phase === 'closing') {
    notices.getState().show({ kind: 'busy', fileName });
    return;
  }
  if (!sessionChecked) return;
  const replacing = phase === 'manuscript' || phase === 'memory';
  if (!replacing && !canAcceptFile(experience.getState())) return;

  const maxBytes = config.getState().config?.maxUploadBytes ?? FALLBACK_MAX_UPLOAD_BYTES;
  const verdict = await validate(file, { maxBytes });
  if (!verdict.ok) {
    notices.getState().show({ kind: 'rejected', error: verdict.error, fileName });
    return;
  }
  notices.getState().clear();
  // What the diary is doing can change while the file is read; decide on what it is doing now.
  const now = experience.getState();
  if (now.phase === 'manuscript' || now.phase === 'memory') {
    confirm.getState().ask({ kind: 'replace', file });
  } else if (canAcceptFile(now)) {
    now.dispatch({ type: 'FILE_SELECTED', file });
  }
}
