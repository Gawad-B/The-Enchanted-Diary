import { expect, test } from '@playwright/test';

const SESSION_ENDPOINT = '/api/session/document';

test('the stage loads with its live region, a presenter, loaded fonts and no console errors', async ({
  page,
}) => {
  test.setTimeout(150_000); // the 3D module and its first frame can take a long while on a cold development server
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console.error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  const sessionCheck = page.waitForResponse((response) => response.url().endsWith(SESSION_ENDPOINT));
  await page.goto('/?quality=low');
  const sessionResponse = await sessionCheck; // the boot check ran against the real server through the Vite proxy
  expect(sessionResponse.status()).toBe(200);
  expect(await sessionResponse.json()).toEqual({ document: null });

  await expect(page).toHaveTitle('The Enchanted Diary');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1, name: 'The Enchanted Diary' })).toBeAttached();

  const liveRegion = page.getByTestId('live-region');
  await expect(liveRegion).toHaveAttribute('role', 'status');
  await expect(liveRegion).toHaveText('A closed diary lies on an old wooden table.');

  // Exactly one presenter owns the stage: the 3D scene slot, or the 2D fallback. The shell shows a marked placeholder
  // (`scene-loading`) while the 3D module loads, which on a cold development server can take many seconds; the REAL
  // mount point is the one that counts, so wait for it (a long time) before anything below runs. That also keeps errors
  // raised while the scene starts up inside this test's `problems` check.
  await expect(page.locator('[data-testid="scene-mount"], [data-testid="fallback-mount"]')).toHaveCount(1, {
    timeout: 45_000,
  });
  await expect(page.locator('[data-testid="scene-loading"]')).toHaveCount(0);
  // The 3D scene itself must be what is showing (these browsers have software WebGL): not the simple view, which would
  // pass everything below without one 3D frame, and not a session forced to it by a failure (which says so in a notice).
  await expect(page.locator('[data-presenter="scene"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Try the immersive view again' })).toHaveCount(0);

  // The mount is only the start: after it the assets are built a step at a time, the first frame is drawn, and the diary's
  // own pages (the marbled endpaper, a slice per turn of the event loop, and the flyleaf) are drawn after that. Wait for
  // all of it (the `scene:first-frame` performance mark and the pages' own), so errors raised in those later stages are
  // inside the `problems` check too.
  await page.waitForFunction(() => performance.getEntriesByName('scene:first-frame').length > 0, null, {
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      ['endpaper', 'flyleaf'].every(
        (face) => performance.getEntriesByName(`diary:face-ready:${face}`).length > 0,
      ),
    null,
    { timeout: 60_000 },
  );
  // ...and a few frames of the finished scene, so a failure when the faces arrive (a texture upload, a shader) is seen too.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const next = (): void => {
          frames += 1;
          if (frames >= 6) resolve();
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
  );
  await expect(page.locator('[data-presenter="scene"]')).toHaveCount(1);

  // Self-hosted fonts resolved in the dev server: none of the declared faces failed to load.
  const failedFaces = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.status === 'error').map((face) => face.family);
  });
  expect(failedFaces).toEqual([]);

  // The page never scrolls sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  expect(problems).toEqual([]);
});
