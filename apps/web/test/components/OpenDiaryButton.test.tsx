import { act, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { OpenDiaryButton } from '../../src/scene/OpenDiaryButton';
import { anchorStore } from '../../src/state/anchorStore';
import { experienceStore } from '../../src/state/experience';
import { pageEffectsStore } from '../../src/state/pageEffectsStore';
import { resetStores } from './helpers';

beforeEach(() => {
  resetStores();
  anchorStore.getState().reset();
  pageEffectsStore.getState().clearAll();
});

describe('the "Open the diary" button', () => {
  it('is the book itself, for the pointer: hidden from the keyboard and screen readers (the welcome screen has the real button)', () => {
    render(<OpenDiaryButton />);
    const button = screen.getByRole('button', { hidden: true });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveAttribute('tabindex', '-1');
  });

  it('clicking it asks the experience to open the diary', () => {
    render(<OpenDiaryButton />);
    fireEvent.click(screen.getByRole('button', { hidden: true }));
    expect(experienceStore.getState().phase).toBe('opening');
  });

  it('exists only while the diary lies closed and the session is checked', () => {
    experienceStore.setState({ sessionChecked: false });
    const { rerender } = render(<OpenDiaryButton />);
    expect(screen.queryByRole('button', { hidden: true })).toBeNull();
    act(() => {
      experienceStore.setState({ sessionChecked: true });
    });
    expect(screen.getByRole('button', { hidden: true })).toBeInTheDocument();
    act(() => {
      experienceStore.setState({ phase: 'awaiting' });
    });
    rerender(<OpenDiaryButton />);
    expect(screen.queryByRole('button', { hidden: true })).toBeNull();
  });

  it('follows the book through the anchors without re-rendering; before they exist it stays reachable', () => {
    render(<OpenDiaryButton />);
    const button = screen.getByRole('button', { hidden: true });
    expect(button.dataset.placed).toBe('false');
    expect(button.style.display).not.toBe('none');
    act(() => {
      anchorStore.getState().setRects({ book: { x: 100.4, y: 50.6, width: 400, height: 300 } });
      anchorStore.getState().setStable(true);
    });
    expect(button.dataset.placed).toBe('true');
    expect(button.style.transform).toBe('translate(100px, 51px)');
    expect(button.style.width).toBe('400px');
    expect(button.style.height).toBe('300px');
    expect(button.dataset.stable).toBe('true');
    act(() => {
      anchorStore.getState().setRects({ book: { x: 120, y: 60, width: 400, height: 300 } });
      anchorStore.getState().setStable(false);
    });
    expect(button.style.transform).toBe('translate(120px, 60px)');
    expect(button.dataset.stable).toBe('false');
  });

  it("keyboard focus makes the edges glow, and it fades again; the pointer is the scene's business (one place for hover)", () => {
    render(<OpenDiaryButton />);
    const button = screen.getByRole('button', { hidden: true });
    fireEvent.pointerEnter(button);
    expect(pageEffectsStore.getState().values.edgeGlow).toBe(0);
    fireEvent.focus(button);
    expect(pageEffectsStore.getState().values.edgeGlow).toBeGreaterThan(0.3);
    fireEvent.blur(button);
    expect(pageEffectsStore.getState().values.edgeGlow).toBe(0);
  });

  it('clears the glow when it goes away', () => {
    const { unmount } = render(<OpenDiaryButton />);
    fireEvent.focus(screen.getByRole('button', { hidden: true }));
    expect(pageEffectsStore.getState().values.edgeGlow).toBeGreaterThan(0.3);
    unmount();
    expect(pageEffectsStore.getState().values.edgeGlow).toBe(0);
  });

  it('passes an automated accessibility check', async () => {
    const { container } = render(<OpenDiaryButton />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
