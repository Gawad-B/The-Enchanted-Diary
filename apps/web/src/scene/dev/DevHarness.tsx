import type { Direction, DocumentDetail } from '@enchanted/shared';
import { useEffect, useRef, useState } from 'react';
import { documentStore } from '../../state/documentStore';
import { experienceStore, type Phase } from '../../state/experience';
import { pageEffectsStore } from '../../state/pageEffectsStore';
import { readerStore, useReaderStore } from '../../state/readerStore';
import { settingsStore } from '../../state/settingsStore';
import { snapshotPerf } from '../perf';

/*
 * Development-only scene harness (`?scene=dev`): a small panel to force phases, the page count, the direction
 * and the spread, and to read the frame rate and renderer statistics. It exists for visual QA and is imported
 * only in development builds, so it is not part of the production bundle. Every control writes to the real
 * stores, so the presenter reacts exactly as it would in production.
 *
 * URL parameters apply once on load: phase, pages, dir (ltr|rtl), spread, lang (en|ar), rm=1 (reduced motion),
 * snap=1 (jump to the pose instead of animating), effects=hover|reading|glow.
 */

const PHASES: readonly Phase[] = [
  'discovery',
  'opening',
  'awaiting',
  'uploading',
  'reading',
  'unveiling',
  'manuscript',
  'revealing',
  'memory',
  'closing',
];

function fakeDocument(pageCount: number, direction: Direction): DocumentDetail {
  const arabic = direction === 'rtl';
  return {
    id: '00000000-0000-4000-8000-000000000001',
    filename: arabic ? 'تقرير سنوي عن المكتبة.pdf' : 'Annual report on the archive, 2024.pdf',
    byteSize: 2_400_000,
    pageCount,
    status: 'ready',
    stage: 'ready',
    primaryLanguage: arabic ? 'ar' : 'en',
    direction,
    createdAt: '2026-03-14T09:30:00.000Z',
    expiresAt: '2026-03-15T09:30:00.000Z',
    languages: arabic
      ? [
          { code: 'ar', share: 0.9 },
          { code: 'en', share: 0.1 },
        ]
      : [{ code: 'en', share: 1 }],
    pages: [],
    warnings: [],
    sections: [],
    chunkCount: 0,
  };
}

function applyBook(pages: number, direction: Direction): void {
  const reader = readerStore.getState();
  // The harness may flip an open book's direction, which production never does: lay the book out at once.
  window.__diary?.layout(direction);
  if (pages > 0) {
    documentStore.getState().setDocument(fakeDocument(pages, direction));
    reader.setDocument(pages, direction);
  } else {
    documentStore.getState().setDocument(null);
    reader.clearDocument();
    reader.setDirection(direction);
  }
}

function goToPhase(phase: Phase): void {
  const state = experienceStore.getState();
  experienceStore.setState({ phase, epoch: state.epoch + 1, sessionChecked: true, error: null });
}

function applyUrl(): void {
  const params = new URLSearchParams(location.search);
  const pages = Number(params.get('pages') ?? '0');
  const direction: Direction = params.get('dir') === 'rtl' ? 'rtl' : 'ltr';
  const lang = params.get('lang');
  if (lang === 'ar' || lang === 'en') settingsStore.getState().setUiLanguage(lang);
  if (params.get('rm') === '1') settingsStore.getState().setReducedMotion('reduce');
  applyBook(Number.isFinite(pages) ? pages : 0, direction);
  const spread = Number(params.get('spread'));
  if (Number.isFinite(spread) && params.has('spread')) readerStore.getState().goToSpread(spread);
  const phase = params.get('phase') as Phase | null;
  if (phase && PHASES.includes(phase)) {
    goToPhase(phase);
    if (params.get('snap') === '1') {
      const open = !['discovery', 'opening', 'reading', 'unveiling'].includes(phase);
      window.__diary?.snap(open, open ? readerStore.getState().spread : 0);
    }
  }
  const cam = params.get('cam')?.split(',').map(Number);
  if (cam?.length === 6 && cam.every(Number.isFinite)) {
    const [px = 0, py = 0, pz = 0, tx = 0, ty = 0, tz = 0] = cam;
    window.__diary?.camera({ position: [px, py, pz], target: [tx, ty, tz] });
  }
  const effect = params.get('effects');
  if (effect === 'hover') pageEffectsStore.getState().set('hover', { edgeGlow: 0.6 });
  if (effect === 'glow')
    pageEffectsStore.getState().set('reveal', { glow: 0.7, edgeGlow: 0.8, inkSpread: 0.5 });
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  left: 8,
  bottom: 8,
  zIndex: 60,
  display: 'grid',
  gap: 4,
  padding: 8,
  maxWidth: 300,
  font: '11px/1.35 ui-monospace, monospace',
  color: '#e9dcc0',
  background: 'rgb(11 9 7 / 0.82)',
  border: '1px solid #a8782f',
};

export default function DevHarness() {
  const [readout, setReadout] = useState('');
  const pageCount = useReaderStore((state) => state.pageCount);
  const direction = useReaderStore((state) => state.direction);
  const spread = useReaderStore((state) => state.spread);
  const [phase, setPhase] = useState<Phase>(experienceStore.getState().phase);
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return undefined;
    // The scene registers its dev handle in an effect; wait for it so `snap=1` and `cam=` find it.
    const timer = window.setInterval(() => {
      if (!window.__diary) return;
      window.clearInterval(timer);
      applied.current = true;
      applyUrl();
    }, 50);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => experienceStore.subscribe((state) => setPhase(state.phase)), []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const perf = snapshotPerf();
      setReadout(
        `${perf.fps.toFixed(1)} fps (worst ${perf.worstMs.toFixed(0)} ms) | ${String(perf.stats.calls)} calls, ${String(perf.stats.triangles)} tris | first frame ${perf.timeToFirstFrameMs === null ? '?' : `${perf.timeToFirstFrameMs.toFixed(0)} ms`}\n${perf.renderer}${perf.software ? ' [software renderer]' : ''}`,
      );
    }, 500);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // `?panel=off` keeps the harness working but hides the panel (clean screenshots).
  const hidden = new URLSearchParams(location.search).get('panel') === 'off';
  return (
    <div
      style={hidden ? { ...panelStyle, visibility: 'hidden', pointerEvents: 'none' } : panelStyle}
      data-testid="scene-dev-harness"
    >
      <label>
        phase{' '}
        <select
          value={phase}
          onChange={(event) => {
            goToPhase(event.target.value as Phase);
          }}
        >
          {PHASES.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <label>
        pages{' '}
        <input
          type="number"
          min={0}
          max={300}
          value={pageCount}
          style={{ width: 60 }}
          onChange={(event) => {
            applyBook(Number(event.target.value), direction);
          }}
        />{' '}
        <select
          value={direction}
          onChange={(event) => {
            applyBook(pageCount, event.target.value as Direction);
          }}
        >
          <option>ltr</option>
          <option>rtl</option>
        </select>
      </label>
      <label>
        spread {spread}{' '}
        <input
          type="range"
          min={0}
          max={Math.ceil(pageCount / 2)}
          value={spread}
          onChange={(event) => {
            readerStore.getState().goToSpread(Number(event.target.value));
          }}
        />
      </label>
      <span>
        <button
          type="button"
          onClick={() => {
            readerStore.getState().prev();
          }}
        >
          prev
        </button>{' '}
        <button
          type="button"
          onClick={() => {
            readerStore.getState().next();
          }}
        >
          next
        </button>{' '}
        <button
          type="button"
          onClick={() => {
            experienceStore.getState().dispatch({ type: 'INTERACT' });
          }}
        >
          INTERACT
        </button>
      </span>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{readout}</pre>
    </div>
  );
}
