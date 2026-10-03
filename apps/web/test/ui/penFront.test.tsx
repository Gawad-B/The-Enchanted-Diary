import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PenFront, frontOf } from '../../src/ui/diary/PenFront';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('frontOf: where the pen front is, from the newest word and its line', () => {
  it("takes the word's place on its line, in the page's own px (the page may be scaled and tilted on the screen)", () => {
    expect(
      frontOf(
        { offsetLeft: 120, offsetTop: 2, offsetWidth: 80, offsetHeight: 30 },
        { offsetLeft: 66, offsetTop: 202 },
      ),
    ).toEqual({ left: 186, top: 204, width: 80, height: 30 });
  });
});

describe('PenFront: the wipe that follows right-to-left ink', () => {
  function Host({ count, active = true }: { count: number; active?: boolean }) {
    return (
      <div className="page" style={{ position: 'relative' }}>
        <div className="pg-line" data-live="" style={{ position: 'absolute', left: 66, top: 202 }}>
          <span className="ink-u ink-u--word">كلمة</span>
        </div>
        <PenFront revealed={count} active={active} />
      </div>
    );
  }

  it('draws an overlay over the newest word each time the pen writes one', () => {
    const view = render(<Host count={1} />);
    view.rerender(<Host count={2} />);
    expect(view.container.querySelectorAll('.pen-front').length).toBeGreaterThan(0);
    expect(view.container.querySelector('.pen-front')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('only follows the words of the exchange being written', () => {
    const view = render(
      <div className="page">
        <div className="pg-line">
          <span className="ink-u ink-u--word">قديم</span>
        </div>
        <PenFront revealed={3} active />
      </div>,
    );
    expect(view.container.querySelectorAll('.pen-front')).toHaveLength(0);
  });

  it('draws nothing when it is not active (reduced motion, left-to-right ink, settled text)', () => {
    const view = render(<Host count={3} active={false} />);
    expect(view.container.querySelectorAll('.pen-front')).toHaveLength(0);
  });

  it('lets a front go when its animation has ended, and keeps only a few at a time', () => {
    vi.useFakeTimers();
    const view = render(<Host count={1} />);
    for (let n = 2; n < 12; n += 1) view.rerender(<Host count={n} />);
    expect(view.container.querySelectorAll('.pen-front').length).toBeLessThanOrEqual(4);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(view.container.querySelectorAll('.pen-front')).toHaveLength(0);
  });
});
