import { useId } from 'react';
import type { Direction } from '@enchanted/shared';

interface ClosedDiaryProps {
  /** The interface direction: an RTL interface binds the book on the right. */
  direction: Direction;
  label: string;
}

/**
 * A static silhouette of the closed diary: a dark burgundy leather cover with a worn gold-dim blind stamp,
 * raised bronze bands on the spine and the page block showing on the fore-edge. It is only the 2D fallback's
 * resting picture; it does nothing and promises nothing.
 */
export function ClosedDiary({ direction, label }: ClosedDiaryProps) {
  const id = useId();
  const cover = `${id}-cover`;
  const spine = `${id}-spine`;
  const wear = `${id}-wear`;
  const grain = `${id}-grain`;
  const pages = `${id}-pages`;
  const clip = `${id}-clip`;
  return (
    <svg
      className={direction === 'rtl' ? 'closed-diary closed-diary--rtl' : 'closed-diary'}
      viewBox="0 0 400 520"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={cover} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--burgundy)' }} />
          <stop offset="0.55" style={{ stopColor: 'var(--burgundy-deep)' }} />
          <stop offset="1" style={{ stopColor: 'var(--umber-deep)' }} />
        </linearGradient>
        <linearGradient id={spine} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--umber-deep)' }} />
          <stop offset="0.6" style={{ stopColor: 'var(--burgundy-deep)' }} />
          <stop offset="1" style={{ stopColor: 'var(--burgundy)', stopOpacity: 0.8 }} />
        </linearGradient>
        <linearGradient id={wear} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--candle-gold)', stopOpacity: 0.5 }} />
          <stop offset="0.45" style={{ stopColor: 'var(--candle-gold)', stopOpacity: 0 }} />
          <stop offset="1" style={{ stopColor: 'var(--bronze)', stopOpacity: 0.35 }} />
        </linearGradient>
        <pattern id={pages} width="6" height="3" patternUnits="userSpaceOnUse">
          <rect width="6" height="3" style={{ fill: 'var(--parchment-dim)' }} />
          <rect width="6" height="1" y="2" style={{ fill: 'var(--umber)', opacity: 0.55 }} />
        </pattern>
        <filter id={grain} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="noise" />
          <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.9 -0.28" />
        </filter>
        <clipPath id={clip}>
          <rect x="14" y="8" width="360" height="492" rx="7" />
        </clipPath>
      </defs>

      {/* page block, visible along the fore-edge and the foot */}
      <rect x="26" y="20" width="360" height="492" rx="5" fill={`url(#${pages})`} />
      <rect
        x="26"
        y="20"
        width="360"
        height="492"
        rx="5"
        style={{ fill: 'none', stroke: 'var(--umber-deep)', strokeWidth: 1 }}
      />

      {/* cover */}
      <rect x="14" y="8" width="360" height="492" rx="7" fill={`url(#${cover})`} />
      <g clipPath={`url(#${clip})`}>
        <rect x="14" y="8" width="360" height="492" filter={`url(#${grain})`} style={{ opacity: 0.55 }} />
        <rect x="14" y="8" width="360" height="492" fill={`url(#${wear})`} />

        {/* spine */}
        <rect x="14" y="8" width="52" height="492" fill={`url(#${spine})`} />
        {[96, 176, 256, 336, 416].map((y) => (
          <g key={y}>
            <rect x="14" y={y} width="52" height="7" style={{ fill: 'var(--bronze)' }} />
            <rect x="14" y={y} width="52" height="2" style={{ fill: 'var(--candle-gold)', opacity: 0.55 }} />
            <rect
              x="14"
              y={y + 5}
              width="52"
              height="2"
              style={{ fill: 'var(--ink-black)', opacity: 0.55 }}
            />
          </g>
        ))}
        <rect x="64" y="8" width="3" height="492" style={{ fill: 'var(--ink-black)', opacity: 0.6 }} />

        {/* blind-stamped border and corner marks */}
        <rect
          x="90"
          y="34"
          width="262"
          height="440"
          rx="3"
          style={{ fill: 'none', stroke: 'var(--gold-dim)', strokeWidth: 1.4, opacity: 0.85 }}
        />
        <rect
          x="98"
          y="42"
          width="246"
          height="424"
          rx="2"
          style={{ fill: 'none', stroke: 'var(--gold-dim)', strokeWidth: 0.7, opacity: 0.6 }}
        />
        {[
          [90, 34, 1, 1],
          [352, 34, -1, 1],
          [90, 474, 1, -1],
          [352, 474, -1, -1],
        ].map(([x, y, sx, sy]) => (
          <path
            key={`${String(x)}-${String(y)}`}
            d={`M ${String(x)} ${String((y ?? 0) + 22 * (sy ?? 1))} V ${String(y)} H ${String((x ?? 0) + 22 * (sx ?? 1))}`}
            style={{ fill: 'none', stroke: 'var(--candle-gold)', strokeWidth: 1.6, opacity: 0.7 }}
          />
        ))}

        {/* medallion with a quill: the same in either direction */}
        <g transform="translate(221 254)">
          <circle r="74" style={{ fill: 'none', stroke: 'var(--gold-dim)', strokeWidth: 1.6 }} />
          <circle
            r="66"
            style={{ fill: 'none', stroke: 'var(--gold-dim)', strokeWidth: 0.7, opacity: 0.8 }}
          />
          <g transform="rotate(28)">
            <path
              d="M 0 -48 C 26 -22 28 22 2 52 C -6 22 -22 -12 0 -48 Z"
              style={{
                fill: 'var(--burgundy-deep)',
                stroke: 'var(--candle-gold)',
                strokeWidth: 1.6,
                opacity: 0.95,
              }}
            />
            <path
              d="M 0 -46 L 2 58"
              style={{ fill: 'none', stroke: 'var(--candle-gold)', strokeWidth: 1.4 }}
            />
            <path
              d="M 2 58 L 4 68"
              style={{ fill: 'none', stroke: 'var(--candle-gold)', strokeWidth: 2.2, strokeLinecap: 'round' }}
            />
          </g>
        </g>
      </g>

      {/* cover edge highlight */}
      <rect
        x="14"
        y="8"
        width="360"
        height="492"
        rx="7"
        style={{ fill: 'none', stroke: 'var(--ink-black)', strokeWidth: 2 }}
      />
    </svg>
  );
}
