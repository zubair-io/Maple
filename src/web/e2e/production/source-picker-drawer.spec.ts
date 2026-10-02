// SourcePickerDrawer — real Browse route and browser pointer-capture coverage (#4028).
import type { Page } from '@playwright/test';
import { test, expect } from '../support/production-test';

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chrome-hosted',
    'Hosted Browse integration of the shared drawer',
  );
});

async function openDrawer(page: Page) {
  await page.goto('/browse');
  await page.getByTestId('source-drawer-toggle').click();
  const drawer = page.getByRole('dialog', { name: 'Library', exact: true });
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  if (!box) throw new Error('drawer has no bounding box');
  return { drawer, box };
}

async function startDrag(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const x = box.x + box.width * 0.75;
  const y = box.y + box.height * 0.75;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return { x, y };
}

for (const width of [320, 375, 430]) {
  test(`drawer uses its rendered 30% swipe threshold at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 812 });
    const { drawer, box } = await openDrawer(page);
    expect(box.width).toBeCloseTo(Math.min(326, width * 0.81), 0);
    await testInfo.attach('drawer-before.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    const start = await startDrag(page, box);
    await page.mouse.move(start.x - box.width * 0.29, start.y, { steps: 8 });
    await page.mouse.up();
    await expect(drawer).toBeVisible();
    await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x)).toBe(0);

    const next = await startDrag(page, box);
    await page.mouse.move(next.x - box.width * 0.31, next.y, { steps: 8 });
    await page.mouse.up();
    await expect(drawer).not.toBeVisible();
    await testInfo.attach('drawer-after.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
}

test('drawer dims using its actual visible width and ignores rightward motion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 812 });
  const { drawer, box } = await openDrawer(page);
  const start = await startDrag(page, box);
  await page.mouse.move(start.x - box.width * 0.25, start.y, { steps: 8 });
  const scrim = page.locator('app-source-picker-drawer .scrim');
  await expect
    .poll(() => scrim.evaluate((el) => Number((el as HTMLElement).style.opacity)))
    .toBeCloseTo(0.45 * 0.75, 2);
  await page.mouse.up();
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x)).toBe(0);

  const next = await startDrag(page, box);
  await page.mouse.move(next.x + box.width * 0.1, next.y, { steps: 8 });
  await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x)).toBe(0);
  await expect
    .poll(() => scrim.evaluate((el) => Number((el as HTMLElement).style.opacity)))
    .toBe(0.45);
  await page.mouse.up();
  await expect(drawer).toBeVisible();
  await page.getByRole('button', { name: 'Close library', exact: true }).click();
  await expect(drawer).not.toBeVisible();
});

test('drawer close button retains its native pointer click', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer } = await openDrawer(page);
  await page.getByRole('button', { name: 'Close library', exact: true }).click();
  await expect(drawer).not.toBeVisible();
});

test('drawer swipes can begin on a control without activating it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer, box } = await openDrawer(page);
  const button = page.getByRole('button', { name: 'Close library', exact: true });
  const buttonBox = await button.boundingBox();
  if (!buttonBox) throw new Error('Close button has no bounding box');
  const x = buttonBox.x + buttonBox.width / 2;
  const y = buttonBox.y + buttonBox.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - box.width * 0.29, y, { steps: 8 });
  await page.mouse.up();
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x)).toBe(0);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - box.width * 0.31, y, { steps: 8 });
  await page.mouse.up();
  await expect(drawer).not.toBeVisible();
});

test('a small pointer movement still activates the drawer control', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer } = await openDrawer(page);
  const button = page.getByRole('button', { name: 'Close library', exact: true });
  const box = await button.boundingBox();
  if (!box) throw new Error('Close button has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 2, y);
  await page.mouse.up();
  await expect(drawer).not.toBeVisible();
});

test('an uncaptured release outside the drawer does not strand its next gesture', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer, box } = await openDrawer(page);
  const x = box.x + box.width - 1;
  const y = box.y + box.height * 0.75;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 3, y);
  await page.mouse.up();
  await expect(drawer).toBeVisible();

  const next = await startDrag(page, box);
  await page.mouse.move(next.x - box.width * 0.31, next.y, { steps: 8 });
  await page.mouse.up();
  await expect(drawer).not.toBeVisible();
});

test('repeated presses on drawer chrome preserve its next swipe', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer, box } = await openDrawer(page);
  const heading = drawer.getByRole('heading', { name: 'Folders', exact: true });
  // Repeated native presses must not select the navigation text: Chrome's
  // text-selection gesture competes with the drawer's pointer sequence.
  await heading.click({ clickCount: 3 });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  const next = await startDrag(page, box);
  await page.mouse.move(next.x - box.width * 0.31, next.y, { steps: 8 });
  await page.mouse.up();
  await expect(drawer).not.toBeVisible();
});

test('cancelled touch drags restore the drawer instead of dismissing it', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer, box } = await openDrawer(page);
  await page.evaluate(() => {
    const events: object[] = [];
    (window as unknown as { drawerPointerEvents: object[] }).drawerPointerEvents = events;
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      document.addEventListener(
        name,
        (event) => {
          const pointer = event as PointerEvent;
          events.push({
            type: pointer.type,
            button: pointer.button,
            primary: pointer.isPrimary,
            pointerType: pointer.pointerType,
            x: pointer.clientX,
            y: pointer.clientY,
            target: (pointer.target as Element)?.tagName,
          });
        },
        { capture: true },
      );
    }
  });
  await testInfo.attach('drawer-touch-policy.json', {
    body: Buffer.from(
      JSON.stringify(
        await drawer.evaluate((el) => ({
          drawer: getComputedStyle(el).touchAction,
          navigation: getComputedStyle(el.querySelector('nav')!).touchAction,
          navigationOverflow: getComputedStyle(el.querySelector('nav')!).overflowX,
        })),
      ),
    ),
    contentType: 'application/json',
  });
  await expect
    .poll(() => drawer.locator('nav').evaluate((el) => getComputedStyle(el).touchAction))
    .toBe('pan-y');
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width * 0.75;
  const y = box.y + box.height * 0.75;
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const fraction of [0.1, 0.2, 0.31]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - box.width * fraction, y }],
      });
    }
    await expect
      .poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x))
      .toBeLessThan(-box.width * 0.3);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(drawer).toBeVisible();
    await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x)).toBe(0);
    await page.getByRole('button', { name: 'Close library', exact: true }).click();
    await expect(drawer).not.toBeVisible();
  } finally {
    await testInfo.attach('drawer-pointer-events.json', {
      body: Buffer.from(
        JSON.stringify(
          await page.evaluate(
            () => (window as unknown as { drawerPointerEvents: object[] }).drawerPointerEvents,
          ),
        ),
      ),
      contentType: 'application/json',
    });
    await cdp.detach();
  }
});

test('a touch swipe in the scrollable source tree dismisses the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer, box } = await openDrawer(page);
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width * 0.75;
  const y = box.y + box.height * 0.75;
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const fraction of [0.1, 0.2, 0.31]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - box.width * fraction, y }],
      });
    }
    await expect
      .poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x))
      .toBeLessThan(-box.width * 0.3);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(drawer).not.toBeVisible();
  } finally {
    await cdp.detach();
  }
});

test('modal keyboard focus enters, wraps, and returns after Escape', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer } = await openDrawer(page);
  const close = drawer.getByRole('button', { name: 'Close library', exact: true });
  await expect(close).toBeFocused();
  const buttons = drawer.getByRole('button');
  const count = await buttons.count();
  // An empty Hosted library exposes only Close; Search is intentionally
  // hidden without the Self Hosted index. Containment must work there too.
  expect(count).toBeGreaterThan(0);
  await page.keyboard.press('Shift+Tab');
  await expect(buttons.last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  for (let index = 1; index < count; index++) {
    await page.keyboard.press('Tab');
    await expect(buttons.nth(index)).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(page.getByTestId('source-drawer-toggle').getByRole('button')).toBeFocused();
});

test('pointer dismissal restores drawer opener focus', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const dismissal of ['close', 'scrim', 'swipe']) {
    const { drawer, box } = await openDrawer(page);
    await expect(drawer.getByRole('button', { name: 'Close library', exact: true })).toBeFocused();
    if (dismissal === 'close') {
      await drawer.getByRole('button', { name: 'Close library', exact: true }).click();
    } else if (dismissal === 'scrim') {
      await page.mouse.click(box.x + box.width + 20, box.y + box.height / 2);
    } else {
      const start = await startDrag(page, box);
      await page.mouse.move(start.x - box.width * 0.31, start.y, { steps: 8 });
      await page.mouse.up();
    }
    await expect(drawer).not.toBeVisible();
    await expect(page.getByTestId('source-drawer-toggle').getByRole('button')).toBeFocused();
  }
});

test('reduced motion disables drawer transitions and preserves gestures', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 812 });
  const { drawer, box } = await openDrawer(page);
  const scrim = page.locator('app-source-picker-drawer .scrim');
  await expect
    .poll(() => drawer.evaluate((el) => getComputedStyle(el).transitionDuration))
    .toBe('0s');
  await expect
    .poll(() => scrim.evaluate((el) => getComputedStyle(el).transitionDuration))
    .toBe('0s');
  const start = await startDrag(page, box);
  await page.mouse.move(start.x - box.width * 0.29, start.y, { steps: 8 });
  await page.mouse.up();
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().x)).toBe(0);
  const next = await startDrag(page, box);
  await page.mouse.move(next.x - box.width * 0.31, next.y, { steps: 8 });
  await page.mouse.up();
  await expect(drawer).not.toBeVisible();
});
