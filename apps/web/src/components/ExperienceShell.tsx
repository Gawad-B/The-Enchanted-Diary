import { Suspense, lazy, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { detectWebGL as defaultDetectWebGL, type WebGLSupport } from '../lib/webgl';
import { useStrings } from '../i18n/useStrings';
import { useAnchorStore } from '../state/anchorStore';
import { useConfirmStore } from '../state/confirmStore';
import { useDiaryBook } from '../state/diaryBook';
import { useExperienceStore } from '../state/experience';
import { useSettingsStore } from '../state/settingsStore';
import { FallbackMount } from './FallbackMount';
import { ForcedSimpleNotice } from './ForcedSimpleNotice';
import { SceneBoundary } from './SceneBoundary';
import { IngestProgress } from '../ui/progress/IngestProgress';
import { ConfirmDialogHost } from '../ui/reader/ConfirmDialog';
import { ReaderBar } from '../ui/reader/ReaderBar';
import { ReaderUi } from '../ui/reader/ReaderUi';
import { UploadPortal } from '../ui/upload/UploadPortal';
import { Welcome } from '../ui/upload/Welcome';
import { DiaryWriting } from '../ui/diary/DiaryWriting';
import { SettingsMenu } from '../ui/settings/SettingsMenu';
import { TruthScene } from '../ui/truth/TruthScene';

// Loaded only when the immersive presenter is in use, so the 3D code never reaches the simple view.
const SceneMount = lazy(() => import('../scene/SceneMount'));

interface ExperienceShellProps {
  /** Replaceable for tests; the default creates a throwaway WebGL context. */
  detectWebGL?: () => WebGLSupport;
}

/**
 * The stage: a dark room with a CSS vignette (which steps aside when the 3D scene draws its own), a screen-reader live region, and one slot that holds exactly
 * one presenter: the lazy 3D scene (WebGL available, immersive view) or the 2D fallback.
 */
export function ExperienceShell({ detectWebGL = defaultDetectWebGL }: ExperienceShellProps) {
  const strings = useStrings();
  const { t, language, direction } = strings;
  const phase = useExperienceStore((state) => state.phase);
  // A question is up: the rest of the stage is inert (a modal dialog is the only thing the reader can reach).
  const modal = useConfirmStore((state) => state.request !== null);
  // The reader is writing on the diary's page: the manuscript's own page controls step aside (diary.css).
  const writing = useDiaryBook((state) => state.writing);
  const sceneVignette = useAnchorStore((state) => state.sceneVignette);
  const view = useSettingsStore((state) => state.view);
  const forcedSimple = useSettingsStore((state) => state.forcedSimple);
  const webgl = useMemo(() => detectWebGL(), [detectWebGL]);

  // A phase change often removes the control that had the focus (Choose, a menu item, the bar): the focus would be lost to
  // the page. It goes to the stage itself, from where the next Tab reaches the first control of the new phase. Never taken
  // from a control that has it, and not at the first render (the page has only just loaded).
  const main = useRef<HTMLElement>(null);
  const firstPhase = useRef(true);
  useEffect(() => {
    if (firstPhase.current) {
      firstPhase.current = false;
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) main.current?.focus({ preventScroll: true });
  }, [phase]);

  const useScene = webgl.supported && view === 'immersive' && forcedSimple === null;
  // Forced simple already explains itself through the notice; only a browser without WebGL needs its own line.
  const fallback = (
    <FallbackMount webglReason={webgl.supported ? undefined : (webgl.reason ?? 'unknown reason')} />
  );

  // An error is announced by its own `role="alert"` line where it is shown; this region only says where the diary is.
  const announcement = t.live[phase];
  const presenter: ReactNode = useScene ? (
    <SceneBoundary fallback={fallback}>
      {/* While the 3D module loads (a few seconds on a cold development server) the slot already holds an inert, marked
          placeholder; it is not the scene's mount point (that is `scene-mount`, which appears when the module has loaded). */}
      <Suspense
        fallback={
          <div
            className="scene-mount"
            data-testid="scene-loading"
            data-loading="true"
            aria-hidden="true"
            style={{ pointerEvents: 'none' }}
          />
        }
      >
        <SceneMount />
      </Suspense>
    </SceneBoundary>
  ) : (
    fallback
  );

  return (
    <div
      className="stage"
      data-phase={phase}
      data-writing={writing || undefined}
      data-presenter={useScene ? 'scene' : 'fallback'}
      data-vignette={useScene && sceneVignette ? 'scene' : 'css'}
      lang={language}
      dir={direction}
    >
      <main className="stage__main" ref={main} tabIndex={-1} aria-label={t.app.stageLabel} inert={modal}>
        <h1 className="visually-hidden">{t.app.title}</h1>
        <div
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="live-region"
        >
          {announcement}
        </div>
        <div className="stage__presenter" data-swipe-surface>
          {presenter}
        </div>
        <ForcedSimpleNotice />
        {/* Over the presenter, not inside it: the scene listens for pointers on its whole mount, and a control inside would
            also hit the book behind it. Inside <main>, so that every control belongs to a landmark. */}
        <div className="stage__overlay">
          {useScene && <Welcome />}
          <UploadPortal />
          <IngestProgress />
          {/* The simple view has no pages to browse and no page to write on: only the 3D book has these. */}
          {useScene && <ReaderUi />}
          {useScene && <DiaryWriting />}
          {useScene && <TruthScene />}
          <SettingsMenu />
        </div>
      </main>
      <div className="stage__vignette" aria-hidden="true" />
      <footer className="stage__footer" role="contentinfo" inert={modal}>
        {useScene && <ReaderBar />}
        <p className="stage__disclaimer" dir={direction}>
          {t.app.fanDisclaimer}
        </p>
      </footer>
      {/* At the root of the stage, above the footer: nothing of the stage (the reader bar included) may sit over the dialog. */}
      <ConfirmDialogHost />
    </div>
  );
}
