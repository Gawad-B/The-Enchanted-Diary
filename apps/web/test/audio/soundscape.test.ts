import { afterEach, describe, expect, it, vi } from 'vitest';
import { MASTER_GAIN, createSoundscape } from '../../src/audio/soundscape';
import { createDiaryBookStore } from '../../src/state/diaryBook';
import { createReaderStore } from '../../src/state/readerStore';
import { createSettingsStore } from '../../src/state/settingsStore';

/** Just enough of an AudioContext to run the graph; records what the soundscape builds. */
function fakeContext() {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const sources: { start: ReturnType<typeof vi.fn> }[] = [];
  const context = {
    state: 'running' as AudioContextState,
    currentTime: 0,
    sampleRate: 8000,
    destination: node(),
    createGain: vi.fn(() => ({ ...node(), gain: param() })),
    createBiquadFilter: vi.fn(() => ({ ...node(), type: 'lowpass', frequency: param(), Q: param() })),
    createBuffer: vi.fn((_c: number, length: number) => ({ getChannelData: () => new Float32Array(length) })),
    createBufferSource: vi.fn(() => {
      const source = { ...node(), buffer: null, loop: false, start: vi.fn(), stop: vi.fn() };
      sources.push(source);
      return source;
    }),
    resume: vi.fn(() => {
      context.state = 'running';
      return Promise.resolve();
    }),
    suspend: vi.fn(() => {
      context.state = 'suspended';
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      context.state = 'closed';
      return Promise.resolve();
    }),
  };
  return { context, sources };
}

function setup(options: { sound?: boolean; gesture?: boolean } = {}) {
  const settings = createSettingsStore({ storage: null, matchMedia: null, language: 'en' });
  if (options.sound) settings.getState().setSound(true);
  const reader = createReaderStore({ pageCount: 40, hasDocument: true });
  const diary = createDiaryBookStore();
  const fake = fakeContext();
  const createContext = vi.fn(() => fake.context as unknown as AudioContext);
  const stop = createSoundscape({
    settings,
    reader,
    diary,
    createContext,
    gestureActive: () => options.gesture ?? false,
    random: () => 0.1,
  });
  return { settings, reader, diary, fake, createContext, stop };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the soundscape', () => {
  it('is off by default and creates no AudioContext while disabled, whatever the visitor does', () => {
    const h = setup();
    document.dispatchEvent(new Event('pointerdown'));
    h.reader.getState().goToSpread(3);
    expect(h.settings.getState().sound).toBe(false);
    expect(h.createContext).not.toHaveBeenCalled();
    h.stop();
  });

  it('after enabling, waits for the first user gesture before it creates the context', () => {
    const h = setup();
    h.settings.getState().setSound(true);
    expect(h.createContext).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('pointerdown'));
    expect(h.createContext).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('pointerdown'));
    expect(h.createContext).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('creates it at once when the click that turned the sound on is itself the gesture; master gain 0.5', () => {
    const h = setup({ gesture: true });
    h.settings.getState().setSound(true);
    expect(h.createContext).toHaveBeenCalledTimes(1);
    const gains = h.fake.context.createGain.mock.results.map((r) => r.value as { gain: { value: number } });
    expect(gains.some((g) => g.gain.value === MASTER_GAIN)).toBe(true);
    expect(MASTER_GAIN).toBe(0.5);
    h.stop();
  });

  it('plays a riffle when the book turns and suspends when the sound is turned off', () => {
    const h = setup({ sound: true, gesture: true });
    // The ambience source plus no riffle yet.
    const before = h.fake.sources.length;
    h.reader.getState().goToSpread(4);
    expect(h.fake.sources.length).toBeGreaterThan(before);
    h.settings.getState().setSound(false);
    expect(h.fake.context.suspend).toHaveBeenCalled();
    const after = h.fake.sources.length;
    h.reader.getState().goToSpread(2);
    expect(h.fake.sources.length).toBe(after); // nothing plays while suspended
    h.stop();
  });

  it('scratches while a question is typed into the writing field', () => {
    const h = setup({ sound: true, gesture: true });
    const before = h.fake.sources.length;
    const field = document.createElement('textarea');
    document.body.append(field);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.fake.sources.length).toBeGreaterThan(before);
    field.remove();
    h.stop();
  });

  it('is muted when the tab is hidden and resumes when it is visible again', () => {
    const h = setup({ sound: true, gesture: true });
    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.fake.context.suspend).toHaveBeenCalled();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.fake.context.resume).toHaveBeenCalled();
    hidden.mockRestore();
    h.stop();
  });

  it('closes the context when stopped', () => {
    const h = setup({ sound: true, gesture: true });
    h.stop();
    expect(h.fake.context.close).toHaveBeenCalled();
  });
});
