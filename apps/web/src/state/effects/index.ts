import { startSoundscape } from '../../audio/soundscape';
import { startDiaryPages } from '../../diarypage/controller';
import { startAskEffect } from './ask';
import { startCloseEffect } from './close';
import { startConfigEffect } from './config';
import { startConfirmEffect } from './confirm';
import { startConversationEffect } from './conversation';
import { startIngestEffect } from './ingest';
import { startRevealEffect } from './reveal';
import { startUploadEffect } from './upload';

/**
 * Every network side effect of the experience, started once for the life of the page. Components only dispatch; these react
 * to the phases. The close effect is registered before the upload effect on purpose: when a replacement upload follows a
 * closing, the book has let the old document go before the new file is taken in.
 */
export function startEffects(): () => void {
  const stops = [
    startConfigEffect(),
    startCloseEffect(),
    startConfirmEffect(),
    startUploadEffect(),
    startIngestEffect(),
    startAskEffect(),
    startConversationEffect(),
    startDiaryPages(),
    startRevealEffect(),
    startSoundscape(),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
