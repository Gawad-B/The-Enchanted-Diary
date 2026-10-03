import { expect, test, type Page } from '@playwright/test';
import {
  TEXT,
  ask,
  latinLetters,
  offerFile,
  openAndStart,
  seedSettings,
  type Lang,
  type View,
} from '../support/journey.js';

/*
 * The deterministic journeys (ScriptedLlm + FakeEmbeddings through apps/server/test/e2e-server.ts: no Gemini calls).
 * Welcome -> riffle -> upload page -> upload -> ingestion -> a question written on the page -> the answer -> "Show me the
 * truth" -> the cited page -> "Return to my page". Roles and labels only; the stage is canvas, so the answer is read
 * from the diary's own accessible log.
 */

const QUESTION = {
  en: {
    file: 'tips-hindawi-university.pdf',
    text: 'When was Tips Hindawi University founded?',
    cited: /\bpage\b/i,
  },
  ar: { file: 'arabic.pdf', text: 'متى بنيت المكتبة القديمة؟', cited: /./ },
} as const;

/** The text of every polite log on the page: what the diary wrote, as assistive technology reads it. */
async function logText(page: Page): Promise<string> {
  return page
    .locator('[role="log"]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent).join('\n'));
}

async function journey(page: Page, lang: Lang, view: View): Promise<void> {
  test.setTimeout(420_000);
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await seedSettings(page, { lang, view });
  await openAndStart(page, lang);
  await offerFile(page, QUESTION[lang].file);

  await ask(page, lang, QUESTION[lang].text);

  // The answer: the diary's reply appears in its log and offers the way to check it.
  const truth = page.getByRole('button', { name: TEXT[lang].truth }).first();
  await expect(truth).toBeVisible({ timeout: 180_000 });
  const log = await logText(page);
  expect(log).toContain(QUESTION[lang].text);
  expect(log.length).toBeGreaterThan(QUESTION[lang].text.length + 20);

  if (lang === 'ar') {
    // Section T.2: no English anywhere in the Arabic experience (the document's own words and proper names excepted).
    const visible = await page.evaluate(() => document.body.innerText);
    for (const [where, text] of [
      ['the diary log', log],
      ['the page', visible],
    ] as const) {
      expect(latinLetters(text.replace(/arabic\.pdf/giu, '')), `Latin letters in ${where}`).toBe('');
    }
  }

  // Show me the truth: the scene opens on the cited page, then "Return to my page" brings the visitor back.
  await truth.click();
  if (view === 'simple') {
    // The simple view's truth is a modal dialog over the cards, closed by its one button.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole('img')).toHaveAttribute('data-drawn', 'true', { timeout: 90_000 });
    await dialog.getByRole('button').click();
    await expect(dialog).toHaveCount(0);
  } else {
    const scene = page.getByTestId('truth-scene');
    await expect(scene).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('truth-return')).toBeEnabled({ timeout: 90_000 });
    await expect(page.getByTestId('truth-page')).toBeVisible();
    await page.getByTestId('truth-return').click();
    await expect(scene).toHaveCount(0, { timeout: 60_000 });
  }
  // Back on the visitor's own page: the answer and its "Show me the truth" link are there again.
  await expect(page.getByRole('button', { name: TEXT[lang].truth }).first()).toBeVisible({ timeout: 60_000 });

  expect(problems).toEqual([]);
}

test('English: welcome, riffle, upload, question, answer, the truth, back @mobile', async ({ page }) => {
  await journey(page, 'en', 'immersive');
  await expect(page.locator('[data-presenter="scene"]')).toHaveCount(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

test('Arabic: the same journey in the Arabic interface has no English in it', async ({ page }) => {
  await journey(page, 'ar', 'immersive');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('Simple (2D) view: the same journey', async ({ page }) => {
  await journey(page, 'en', 'simple');
  await expect(page.locator('[data-presenter="fallback"]')).toHaveCount(1);
});
