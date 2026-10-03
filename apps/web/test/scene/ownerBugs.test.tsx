import { act, render, screen } from '@testing-library/react';
import { PerspectiveCamera, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { facesOnSpread } from '../../src/book/bookLayout';
import { BookMotion } from '../../src/scene/book/bookMotion';
import { AMBIENT_START, PhaseRunner, midSpread, type PresenterEnv } from '../../src/scene/book/phaseRunner';
import { PAGE_H, PAGE_W } from '../../src/scene/book/dimensions';
import { applyPose, framingFor, writingUp } from '../../src/scene/cameraFraming';
import { diaryBookStore } from '../../src/state/diaryBook';
import { experienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { readerStore } from '../../src/state/readerStore';
import { ReaderBar } from '../../src/ui/reader/ReaderBar';
import { UploadPortal } from '../../src/ui/upload/UploadPortal';
import { resetStores } from '../components/helpers';

/* Owner test, round 3: no close after the upload, the writing page is level, the welcome never shows the flyleaf and never turns back. */

function env(motion: BookMotion): PresenterEnv {
  return {
    motion,
    layoutDirection: () => 'ltr',
    setLayoutDirection: () => undefined,
    desiredDirection: () => 'ltr',
    readerSpread: () => midSpread(motion.leafCount) + 6,
    pageTexturesReady: () => true,
    emit: () => undefined,
  };
}

describe('bug 1: the cover stays open from the upload through the manuscript (no close, no reopen)', () => {
  it('awaiting -> uploading -> reading -> unveiling -> manuscript: the cover is at 1 on every frame', () => {
    const motion = new BookMotion({ leafCount: 40, reducedMotion: false, maxAirborne: 4 });
    motion.snap({ open: true, spread: midSpread(40) });
    const e = env(motion);
    for (const phase of ['awaiting', 'uploading', 'reading', 'unveiling', 'manuscript'] as Phase[]) {
      const runner = new PhaseRunner(phase, 1, e);
      for (let i = 0; i < 60 * 12; i += 1) {
        runner.tick();
        motion.update(1 / 60);
        expect(motion.cover.value, `${phase} frame ${String(i)}`).toBe(1);
        if (phase === 'unveiling' && runner.finished) break;
      }
    }
  });
});

describe('bug 2: the writing view faces the page squarely: its top edge is level on screen', () => {
  const size = { width: 1440, height: 900 };
  const topEdge = (position: Vector3, target: Vector3, up: [number, number, number]) => {
    const camera = new PerspectiveCamera(38, size.width / size.height, 0.05, 60);
    camera.position.copy(position);
    camera.up.set(...up);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const at = (x: number) => {
      const v = new Vector3(x, 0.3, -PAGE_H / 2).project(camera);
      return { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height };
    };
    return [at(0), at(PAGE_W)] as const;
  };
  const pose = framingFor({
    phase: 'manuscript',
    ...size,
    direction: 'ltr',
    leafCount: 40,
    focusSide: 'right',
    closely: true,
    writing: true,
  });
  const position = new Vector3(pose.position.x, pose.position.y, pose.position.z);
  const target = new Vector3(pose.target.x, pose.target.y, pose.target.z);

  it('at rest, with the up-vector along the page: the page top-left and top-right corners are within 1 px in y', () => {
    applyPose(new PerspectiveCamera(), pose);
    const [left, right] = topEdge(position, target, writingUp(true));
    expect(Math.abs(left.y - right.y)).toBeLessThan(1);
  });

  it('the cause of the slant: a sideways lean (the pointer parallax) over a near-vertical view rolls the picture with the default up-vector; the writing view takes no lean', () => {
    const leaned = position.clone().add(new Vector3(0.12, 0.03, 0));
    const [left, right] = topEdge(leaned, target, [0, 1, 0]);
    expect(Math.abs(left.y - right.y)).toBeGreaterThan(1);
    // and with the page's own up-vector the same lean no longer rolls it
    const [l2, r2] = topEdge(leaned, target, writingUp(true));
    expect(Math.abs(l2.y - r2.y)).toBeLessThan(Math.abs(left.y - right.y));
    expect(writingUp(false)).toEqual([0, 1, 0]);
  });

  it('the "Write in the diary" button is not there while writing', () => {
    resetStores();
    readerStore.getState().setDocument(10, 'ltr');
    experienceStore.setState({
      ...initialExperienceState,
      phase: 'manuscript',
      sessionChecked: true,
      documentId: 'x',
    });
    diaryBookStore.getState().stopWriting();
    const { unmount } = render(<ReaderBar />);
    expect(screen.queryByTestId('write-toggle')).not.toBeNull();
    unmount();
    diaryBookStore.getState().startWriting(0);
    render(<ReaderBar />);
    expect(screen.queryByTestId('write-toggle')).toBeNull();
    diaryBookStore.getState().stopWriting();
  });
});

describe('the welcome screen: past the flyleaf, forward only, from the first frame', () => {
  it('starts on a blank page past the flyleaf (no invitation face), and never turns a leaf back, for a minute', () => {
    const motion = new BookMotion({ leafCount: 40, reducedMotion: false, maxAirborne: 4 });
    motion.snap({ open: true, spread: AMBIENT_START });
    const faces = facesOnSpread(AMBIENT_START, 0, 'ltr', false, 0);
    expect(faces.left === 'flyleaf' || faces.right === 'flyleaf').toBe(false);
    const runner = new PhaseRunner('discovery', 1, env(motion));
    runner.tick();
    expect(motion.turning).toBe(true); // it starts at once
    let turned = 0;
    for (let i = 0; i < 60 * 60; i += 1) {
      runner.tick();
      motion.update(1 / 60);
      for (let leaf = 0; leaf < motion.leafCount; leaf += 1) {
        expect(motion.turnSigns[leaf], `leaf ${String(leaf)} at frame ${String(i)}`).not.toBe(-1);
        if (motion.turnSigns[leaf] === 1) turned += 1;
      }
      expect(motion.cover.value).toBe(1);
    }
    expect(turned).toBeGreaterThan(100);
  });
});

describe('bug 4: the first frames show the welcome and nothing of the upload', () => {
  beforeEach(() => {
    resetStores();
  });

  it.each(['discovery', 'awaiting'] as const)(
    'with the session unchecked (phase %s) no upload button is in the DOM',
    (phase) => {
      experienceStore.setState({ ...initialExperienceState, phase, sessionChecked: false });
      render(<UploadPortal />);
      expect(screen.queryAllByRole('button', { hidden: true })).toHaveLength(0);
      expect(screen.queryByTestId('upload-portal')).toBeNull();
      act(() => {
        experienceStore.setState({ sessionChecked: true });
      });
      expect(screen.queryByTestId('upload-portal') !== null).toBe(phase === 'awaiting');
    },
  );
});
