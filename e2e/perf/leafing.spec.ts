import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { TEXT, ask, offerFile, seedSettings } from '../support/journey.js';

/*
 * Perf smoke: loads the 40-page fixture, then records frame times and long tasks for 10 s of riffling (the "Show me the
 * truth" riffle, then whatever the scene does after it). No thresholds: the numbers go to test-results/perf-smoke.json and the
 * console. With the default launch args the renderer is software WebGL (SwiftShader), and the report says so.
 */

interface Sample {
  frames: number;
  fps: number;
  frameMsMedian: number;
  frameMsP95: number;
  frameMsMax: number;
  longTasks: number;
  longTaskMsTotal: number;
}

const START = `(() => {
  const state = { last: performance.now(), deltas: [], longs: [], running: true };
  const tick = (now) => { state.deltas.push(now - state.last); state.last = now; if (state.running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) state.longs.push(e.duration); })
      .observe({ type: 'longtask', buffered: false });
  } catch {}
  window.__perf = state;
})()`;

async function measure(page: Page, action: () => Promise<void>, ms: number): Promise<Sample> {
  await page.evaluate(START);
  await action();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const state = (window as unknown as { __perf: { running: boolean; deltas: number[]; longs: number[] } })
      .__perf;
    state.running = false;
    const sorted = [...state.deltas.slice(1)].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    const total = state.deltas.slice(1).reduce((sum, d) => sum + d, 0);
    return {
      frames: sorted.length,
      fps: total === 0 ? 0 : Math.round((sorted.length / total) * 10000) / 10,
      frameMsMedian: Math.round(at(0.5) * 10) / 10,
      frameMsP95: Math.round(at(0.95) * 10) / 10,
      frameMsMax: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
      longTasks: state.longs.length,
      longTaskMsTotal: Math.round(state.longs.reduce((sum, d) => sum + d, 0)),
    };
  });
}

test('perf smoke: 10 s of riffling with the 40-page manuscript loaded', async ({ page }) => {
  test.setTimeout(420_000);
  await seedSettings(page, { lang: 'en', view: 'immersive' });
  await page.goto('/?quality=low');
  const start = page.getByRole('button', { name: TEXT.en.start });
  await expect(start).toBeEnabled({ timeout: 90_000 });
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });

  // Window 1: the long riffle that opens the diary (pressing the welcome button).
  const opening = await measure(page, () => start.click(), 10_000);

  await offerFile(page, 'multi-page-long.pdf');
  await ask(page, 'en', 'What does page 7 say?');
  const truth = page.getByRole('button', { name: TEXT.en.truth }).first();
  await expect(truth).toBeVisible({ timeout: 180_000 });

  // Window 2: the riffle to the cited page.
  const riffle = await measure(page, () => truth.click(), 10_000);

  const result = {
    renderer,
    softwareRenderer: /swiftshader|llvmpipe|software/iu.test(renderer),
    opening,
    truthRiffle: riffle,
  };
  mkdirSync(path.resolve(import.meta.dirname, '..', '..', 'test-results'), { recursive: true });
  writeFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'test-results', 'perf-smoke.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(`PERF ${JSON.stringify(result)}`);
  expect(opening.frames).toBeGreaterThan(0);
});
