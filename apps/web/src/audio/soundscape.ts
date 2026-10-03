import { diaryBookStore, type DiaryBookStore } from '../state/diaryBook';
import { readerStore, type ReaderStore } from '../state/readerStore';
import { settingsStore, type SettingsStore } from '../state/settingsStore';

/*
 * The diary's sound, kept to three things and all of it synthesised on the spot (no audio files): the candle (a low murmur of
 * filtered brown noise with sparse crackles), the riffle of pages, and the quill's scratch while a question is typed. It is
 * OFF by default. Nothing is created until the visitor turns it on AND then makes a gesture (a browser only lets sound start
 * after one); turning it off or hiding the tab suspends it. It listens to the stores and to typing; nothing in the scene
 * knows it exists.
 */

export const MASTER_GAIN = 0.5;
const MAX_RIFFLE_LEAVES = 10;
const CRACKLE_TICK_MS = 700;

export interface SoundscapeDeps {
  settings: Pick<SettingsStore, 'getState' | 'subscribe'>;
  reader: Pick<ReaderStore, 'getState' | 'subscribe'>;
  diary: Pick<DiaryBookStore, 'getState' | 'subscribe'>;
  /** Creates the one AudioContext (a fake in tests); called only after sound is on and the visitor made a gesture. */
  createContext: () => AudioContext;
  page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  /** True when the visitor's click that turned the sound on is itself the gesture (the browser's user activation). */
  gestureActive: () => boolean;
  random: () => number;
}

function defaultDeps(): SoundscapeDeps {
  return {
    settings: settingsStore,
    reader: readerStore,
    diary: diaryBookStore,
    createContext: () => new AudioContext(),
    page: document,
    gestureActive: () =>
      (navigator as Partial<Pick<Navigator, 'userActivation'>>).userActivation?.isActive ?? false,
    random: Math.random,
  };
}

function noiseBuffer(context: AudioContext, seconds: number, brown: boolean): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * white) / 1.02;
      data[index] = last * 3.5;
    } else {
      data[index] = white;
    }
  }
  return buffer;
}

/** A burst of band-passed noise with a quick attack and a soft release (a swish, a crackle, a scratch). */
function burst(
  context: AudioContext,
  destination: AudioNode,
  noise: AudioBuffer,
  at: number,
  options: { frequency: number; q: number; peak: number; attack: number; release: number },
): void {
  const source = context.createBufferSource();
  source.buffer = noise;
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = options.frequency;
  filter.Q.value = options.q;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(options.peak, at + options.attack);
  gain.gain.linearRampToValueAtTime(0.0001, at + options.attack + options.release);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  source.start(at, Math.random() * 0.5);
  source.stop(at + options.attack + options.release + 0.02);
}

export function createSoundscape(overrides: Partial<SoundscapeDeps> = {}): () => void {
  const deps = { ...defaultDeps(), ...overrides };
  const { settings, reader, diary, page, random } = deps;
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let white: AudioBuffer | null = null;
  let ambience: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  let crackleTimer: ReturnType<typeof setInterval> | null = null;
  let waitingForGesture = false;
  let lastScratch = -1;

  const wanted = (): boolean => settings.getState().sound && !page.hidden;

  const startAmbience = (ctx: AudioContext, out: AudioNode): void => {
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx, 4, true);
    source.loop = true;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 420;
    const gain = ctx.createGain();
    gain.gain.value = 0.18;
    source.connect(lowpass);
    lowpass.connect(gain);
    gain.connect(out);
    source.start();
    ambience = { source, gain };
  };

  const crackle = (): void => {
    if (!context || !master || !white || context.state !== 'running') return;
    if (random() > 0.55) return;
    const at = context.currentTime + random() * (CRACKLE_TICK_MS / 1000);
    burst(context, master, white, at, {
      frequency: 2400 + random() * 2600,
      q: 1.4,
      peak: 0.05 + random() * 0.05,
      attack: 0.002,
      release: 0.025 + random() * 0.03,
    });
  };

  const build = (): void => {
    if (context) return;
    const ctx = deps.createContext();
    context = ctx;
    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
    white = noiseBuffer(ctx, 0.6, false);
    startAmbience(ctx, master);
    crackleTimer = setInterval(crackle, CRACKLE_TICK_MS);
  };

  const onGesture = (): void => {
    page.removeEventListener('pointerdown', onGesture);
    page.removeEventListener('keydown', onGesture);
    waitingForGesture = false;
    if (wanted()) build();
    apply();
  };

  /** Brings the sound in line with the settings: created on the first gesture after enabling, suspended when off or hidden. */
  const apply = (): void => {
    if (wanted()) {
      if (!context) {
        if (deps.gestureActive()) build();
        else if (!waitingForGesture) {
          waitingForGesture = true;
          page.addEventListener('pointerdown', onGesture);
          page.addEventListener('keydown', onGesture);
        }
      }
      if (context?.state === 'suspended') void context.resume();
    } else if (context?.state === 'running') {
      void context.suspend();
    }
  };

  const riffle = (leaves: number): void => {
    if (!context || !master || !white || context.state !== 'running') return;
    const count = Math.min(Math.max(Math.round(leaves), 1), MAX_RIFFLE_LEAVES);
    for (let index = 0; index < count; index += 1) {
      burst(context, master, white, context.currentTime + index * 0.07, {
        frequency: 1800 + random() * 1600,
        q: 0.7,
        peak: 0.22,
        attack: 0.03,
        release: 0.1,
      });
    }
  };

  const scratch = (): void => {
    if (!context || !master || !white || context.state !== 'running') return;
    const now = context.currentTime;
    if (now - lastScratch < 0.05) return;
    lastScratch = now;
    burst(context, master, white, now, {
      frequency: 3600 + random() * 1200,
      q: 2.2,
      peak: 0.07,
      attack: 0.006,
      release: 0.035,
    });
  };

  const onInput = (event: Event): void => {
    if (event.target instanceof HTMLTextAreaElement) scratch();
  };

  const stopSettings = settings.subscribe((state, previous) => {
    if (state.sound !== previous.sound) apply();
  });
  const stopReader = reader.subscribe((state, previous) => {
    if (state.spread !== previous.spread) riffle(Math.abs(state.spread - previous.spread));
  });
  const stopDiary = diary.subscribe((state, previous) => {
    if (state.page !== previous.page) riffle(Math.abs(state.page - previous.page));
  });
  page.addEventListener('visibilitychange', apply);
  page.addEventListener('input', onInput, true);
  apply();

  return () => {
    stopSettings();
    stopReader();
    stopDiary();
    page.removeEventListener('visibilitychange', apply);
    page.removeEventListener('input', onInput, true);
    page.removeEventListener('pointerdown', onGesture);
    page.removeEventListener('keydown', onGesture);
    if (crackleTimer) clearInterval(crackleTimer);
    try {
      ambience?.source.stop();
    } catch {
      // already stopped
    }
    if (context && context.state !== 'closed') void context.close();
    context = null;
  };
}

/** The app's soundscape, started once with the other effects. */
export function startSoundscape(): () => void {
  return createSoundscape();
}
