import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const FIXTURES = path.resolve(import.meta.dirname, '..', '..', 'fixtures');
export const fixture = (name: string): string => path.join(FIXTURES, name);

export type Lang = 'en' | 'ar';
export type View = 'immersive' | 'simple';

/** The visible strings the journeys look for (the app's own strings, kept here so a copy change is one edit). */
export const TEXT = {
  en: {
    start: 'Start revealing the secrets',
    input: 'Write to the diary',
    truth: 'Show me the truth',
    back: 'Return to my page',
    diaryWrote: 'The diary wrote:',
  },
  ar: {
    start: 'ابدأ كشف الأسرار',
    input: 'اكتب إلى المذكّرة',
    truth: 'أرني الحقيقة',
    back: '',
    diaryWrote: '',
  },
} as const;

const SETTINGS_KEY = 'enchanted-diary.settings.v1';

/** Seeds the persisted settings (language, view) before the app boots: the same thing the settings menu writes. */
export async function seedSettings(page: Page, settings: { lang: Lang; view: View }): Promise<void> {
  await page.addInitScript(
    ([key, lang, view]) => {
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({ quality: 'low', sound: false, reducedMotion: 'system', view, uiLanguage: lang }),
        );
      } catch {
        /* storage blocked: the defaults apply */
      }
    },
    [SETTINGS_KEY, settings.lang, settings.view] as const,
  );
}

/** Opens the app, waits for the stage, and presses the welcome button. */
export async function openAndStart(page: Page, lang: Lang): Promise<void> {
  await page.goto('/?quality=low');
  const start = page.getByRole('button', { name: TEXT[lang].start });
  await expect(start).toBeEnabled({ timeout: 90_000 });
  await start.click();
}

/** Offers a PDF through the upload page's file input and waits until the diary is ready to be written to. */
export async function offerFile(page: Page, file: string): Promise<void> {
  const input = page.getByTestId('file-input');
  await input.waitFor({ state: 'attached', timeout: 90_000 });
  await input.setInputFiles(fixture(file));
}

/** Writes a question on the page (the real textarea) and presses Enter. */
export async function ask(page: Page, lang: Lang, question: string): Promise<void> {
  const field = page.getByRole('textbox', { name: TEXT[lang].input });
  await expect(field).toBeVisible({ timeout: 180_000 });
  await field.click();
  await field.pressSequentially(question, { delay: 10 });
  await field.press('Enter');
}

/** The Latin letters in a string, ignoring the words in `allowed` (a document's own words, proper names). */
export function latinLetters(text: string): string {
  return text.match(/[A-Za-z]+/g)?.join(' ') ?? '';
}
