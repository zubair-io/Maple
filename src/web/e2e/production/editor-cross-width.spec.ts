// editor-cross-width.spec.ts — the web editor's cross-width interaction +
// accessibility acceptance gates (#2451, milestone 18 design spec §3.4).
//
// Runs in `web-build`'s production-artifact job against the BUILT Hosted
// bundle in installed Google Chrome, with no RAW fixture: the editor opens a
// 64×64 PNG generated at test time (`support/gate-image.ts`). Every gate
// records the viewport, input mode, browser engine and build version it ran
// under (`editor-gate.json` attachment), and `scripts/check-e2e-count.ts`
// asserts the run executed exactly 15 of these tests — a count that silently
// drops is not a pass.
//
// What is gated here is layout, reachability, focus order and the
// accessibility tree; colour and render parity stay with the objective
// image harnesses (docs/testing.md). The manifest (#2448) supplies the
// static claims the live tree is checked against: which sliders each group
// must expose, and which dock entries are disabled placeholders.

import type { Browser, Locator, Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/production-test';
import { writeGatePng } from '../support/gate-image';
import {
  EDITOR_PARITY_MANIFEST,
  parityPlaceholders,
} from '../../projects/maple-common/src/lib/editor/parity/editor-parity';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, dockColumn: true },
  { name: 'tablet', width: 800, height: 1024, dockColumn: true },
  { name: 'phone', width: 390, height: 844, dockColumn: false },
] as const;

/** Top-bar actions in visible (left → right) order. */
const TOP_BAR = [
  'Back to Library',
  'Commands',
  'Scopes',
  'Auto adjust',
  'Reset all adjustments',
  'Toggle before/after',
  'Undo',
  'Info',
  'Export',
] as const;

const DOCK = [
  'Light',
  'Color',
  'Effects',
  'Detail',
  'Crop',
  'Tone Curve',
  'Film',
  'Presets',
] as const;
const GROUPS = ['light', 'color', 'effects', 'detail'] as const;

type Viewport = (typeof VIEWPORTS)[number];

function hostedOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== 'chrome-hosted');
}

async function openEditor(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles(await writeGatePng());
  await page.waitForURL(/\/edit\//, { timeout: 30_000 });
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Decoding RAW')).toHaveCount(0, { timeout: 60_000 });
}

/** Record what this gate ran under — the ticket's evidence contract. */
async function recordGate(
  page: Page,
  testInfo: TestInfo,
  viewport: { name: string; width: number; height: number },
  inputMode: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const { product } = await session.send('Browser.getVersion');
  await session.detach();
  const ngsw = (await (await page.request.get('/ngsw.json')).json()) as { timestamp?: number };
  const buildMeta = await page
    .locator('meta[name="maple-e2e-version"]')
    .getAttribute('content')
    .catch(() => null);
  await testInfo.attach('editor-gate.json', {
    body: Buffer.from(
      JSON.stringify(
        {
          viewport,
          inputMode,
          engine: { product, userAgent: await page.evaluate(() => navigator.userAgent) },
          build: { ngswTimestamp: ngsw.timestamp ?? null, artifactVersion: buildMeta },
          reducedMotion: await page.evaluate(
            () => matchMedia('(prefers-reduced-motion: reduce)').matches,
          ),
          devicePixelRatio: await page.evaluate(() => devicePixelRatio),
          ...extra,
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
  await testInfo.attach(`${viewport.name}-${inputMode}.png`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.innerWidth);
}

async function expectInViewport(
  locator: Locator,
  label: string,
  scroll: 'none' | 'into-view' = 'none',
): Promise<void> {
  await expect(locator, label).toBeVisible();
  // The phone dock is a horizontally scrolling bar; its entries count as
  // reachable once scrolled into view. Everything else must be on screen
  // without scrolling.
  if (scroll === 'into-view') await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const size = locator.page().viewportSize()!;
  expect(box, `${label} has a box`).not.toBeNull();
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${label} top edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(size.width + 0.5);
  expect(box!.y + box!.height, `${label} bottom edge`).toBeLessThanOrEqual(size.height + 0.5);
}

/** Every primary action is on screen at the current width. */
async function expectPrimaryActionsReachable(page: Page): Promise<void> {
  await expectNoHorizontalOverflow(page);
  for (const name of TOP_BAR) {
    await expectInViewport(page.getByRole('button', { name, exact: true }), name);
  }
  const dock = page.getByRole('navigation', { name: 'Editor tools' });
  const scrolls = (await page.locator('pro-tool-dock.dock-host--horizontal').count()) > 0;
  for (const name of DOCK) {
    await expectInViewport(
      dock.getByRole('button', { name, exact: true }),
      `dock ${name}`,
      scrolls ? 'into-view' : 'none',
    );
  }
  await expectInViewport(page.getByRole('slider', { name: 'Exposure' }), 'Exposure slider');
}

/** Slider tools the manifest says the web card must expose per group. */
function manifestSliders(group: string): string[] {
  return EDITOR_PARITY_MANIFEST.capabilities
    .filter((row) => row.group === group && row.tool?.web && row.accessibility.role === 'slider')
    .map((row) => row.name);
}

async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return '';
    return (
      el.getAttribute('aria-label') ??
      el.querySelector('.label')?.textContent?.trim() ??
      el.textContent?.trim() ??
      ''
    ).slice(0, 40);
  });
}

/** Names reached by Tab from the first top-bar action, in order, until
 *  `limit` presses or the ring wraps back to it. */
async function tabOrder(page: Page, limit: number): Promise<string[]> {
  // Walk the ring from a fixed anchor — the first top-bar action. Chrome
  // resumes Tab from wherever focus last was, and neither a body click nor a
  // blur reliably rewinds that to the top of the document, so without an
  // anchor the SAME ring reads rotated depending on what ran before.
  const anchor = TOP_BAR[0];
  await page.getByRole('button', { name: anchor, exact: true }).focus();
  const seen: string[] = [anchor];
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const name = await focusedName(page);
    if (name && seen.length > 0 && name === seen[0]) break;
    if (name) seen.push(name);
  }
  return seen;
}

function indexOf(order: readonly string[], name: string): number {
  return order.findIndex((n) => n === name || n.startsWith(name));
}

for (const viewport of VIEWPORTS) {
  test.describe(`editor gates — ${viewport.name}`, () => {
    test.beforeEach(async ({ page }, testInfo) => {
      hostedOnly(testInfo);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test(`layout: no horizontal overflow, every primary action reachable — ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await openEditor(page);
      await expectPrimaryActionsReachable(page);
      // Panels open inside the viewport too.
      await page.getByRole('button', { name: 'Scopes', exact: true }).click();
      await expectInViewport(page.getByRole('region', { name: 'Scopes' }), 'scopes panel');
      await expectNoHorizontalOverflow(page);
      await page.getByRole('button', { name: 'Scopes', exact: true }).click();
      await page.getByRole('button', { name: 'Info', exact: true }).click();
      const inspector = page.locator('[data-editor-region="inspector"]');
      await expect(inspector).toBeVisible();
      await expectNoHorizontalOverflow(page);
      const dockClass = await page.locator('pro-tool-dock').getAttribute('class');
      expect(dockClass?.includes('dock-host--horizontal')).toBe(!viewport.dockColumn);
      await recordGate(page, testInfo, viewport, 'pointer');
    });

    test(`keyboard: focus order follows the visible task order — ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await openEditor(page);
      // One edit first: Undo is correctly disabled with an empty history, and
      // a disabled control takes no focus. AUTO also stays disabled for this
      // PNG fixture because its analysis requires a RAW photo.
      await page.getByRole('slider', { name: 'Exposure' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Auto adjust', exact: true })).toBeDisabled();
      const order = await tabOrder(page, 60);
      // The top bar reads left → right.
      const topBar = TOP_BAR.filter((name) => name !== 'Auto adjust').map((name) =>
        indexOf(order, name),
      );
      expect(indexOf(order, 'Auto adjust'), JSON.stringify(order)).toBe(-1);
      expect(topBar, JSON.stringify(order)).toEqual([...topBar].sort((a, b) => a - b));
      expect(
        topBar.every((i) => i >= 0),
        JSON.stringify(order),
      ).toBe(true);
      // Tools then controls on tablet/desktop (dock column beside the card);
      // controls then tools on phone (card stacked above the bottom dock).
      const light = indexOf(order, 'Light');
      const exposure = indexOf(order, 'Exposure');
      expect(light, JSON.stringify(order)).toBeGreaterThanOrEqual(0);
      expect(exposure, JSON.stringify(order)).toBeGreaterThanOrEqual(0);
      expect(viewport.dockColumn ? light < exposure : exposure < light, JSON.stringify(order)).toBe(
        true,
      );
      // Disabled placeholders never take focus. Which tools ARE placeholders
      // comes from the manifest, not a hard-coded list — a tool that ships
      // (Mask, #1541) leaves the manifest and must then be reachable.
      const placeholders = parityPlaceholders().map((row) => row.name);
      expect(
        order.filter((n) => placeholders.includes(n)),
        JSON.stringify({ order, placeholders }),
      ).toEqual([]);
      // A focused slider owns its arrow keys; Shift+arrow nudges from anywhere.
      const slider = page.getByRole('slider', { name: 'Exposure' });
      await slider.focus();
      const before = await slider.getAttribute('aria-valuenow');
      await page.keyboard.press('ArrowRight');
      await expect(slider).not.toHaveAttribute('aria-valuenow', before ?? '0');
      expect(page.url()).toContain('/edit/');
      await recordGate(page, testInfo, viewport, 'keyboard', { tabOrder: order });
    });

    test(`screen reader: select tools, change and reset values, compare, navigate, export — ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await openEditor(page);
      const dock = page.getByRole('navigation', { name: 'Editor tools' });
      // Every slider the manifest promises per group is exposed by name.
      for (const group of GROUPS) {
        const label = group[0].toUpperCase() + group.slice(1);
        await dock.getByRole('button', { name: label, exact: true }).click();
        await expect(dock.getByRole('button', { name: label, exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        for (const name of manifestSliders(group)) {
          const slider = page.getByRole('slider', { name, exact: true });
          await expect(slider, `${group}/${name}`).toBeVisible();
          await expect(slider).toHaveAttribute('aria-valuemin', /.+/);
          await expect(slider).toHaveAttribute('aria-valuemax', /.+/);
          await expect(slider).toHaveAttribute('aria-valuenow', /.+/);
        }
      }
      // Disabled placeholders: present, disabled, out of the tree, tooltip
      // names the ticket — straight from the manifest.
      for (const row of parityPlaceholders()) {
        const button = page.locator(
          `button[title="${row.name} — coming in ${row.exception!.ticket}"]`,
        );
        await expect(button).toHaveCount(1);
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute('aria-hidden', 'true');
      }
      // Change and reset a value by name.
      await dock.getByRole('button', { name: 'Color', exact: true }).click();
      const tint = page.getByRole('slider', { name: 'Tint', exact: true });
      const initial = await tint.getAttribute('aria-valuenow');
      await tint.focus();
      await page.keyboard.press('ArrowRight');
      await expect(tint).not.toHaveAttribute('aria-valuenow', initial ?? '0');
      await page.getByRole('button', { name: 'Reset Color adjustments', exact: true }).click();
      await expect(tint).toHaveAttribute('aria-valuenow', initial ?? '0');
      // Compare.
      const compare = page.getByRole('button', { name: 'Toggle before/after', exact: true });
      await compare.click();
      await expect(compare).toHaveAttribute('aria-pressed', 'true');
      await compare.click();
      await expect(compare).toHaveAttribute('aria-pressed', 'false');
      // Export — Escape closes the modal, and only the modal (the router
      // lets an open dialog own the key rather than leaving the editor).
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(page.url()).toContain('/edit/');
      // Navigate: Back returns to the Preview for this image; Edit re-enters,
      // with the armed group (Color, above) still armed — so the sliders that
      // come back are that group's, not Light's.
      await page.getByRole('button', { name: 'Back to Library', exact: true }).click();
      await expect(page).toHaveURL(/\/view\//);
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page).toHaveURL(/\/edit\//);
      await expect(dock.getByRole('button', { name: 'Color', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByRole('slider', { name: 'Tint', exact: true })).toBeVisible();
      await recordGate(page, testInfo, viewport, 'screen-reader');
    });

    test(`reduced motion: the same journeys under prefers-reduced-motion — ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openEditor(page);
      await expectPrimaryActionsReachable(page);
      const scopes = page.getByRole('button', { name: 'Scopes', exact: true });
      await scopes.click();
      await expect(page.getByRole('region', { name: 'Scopes' })).toBeVisible();
      await scopes.click();
      await expect(page.getByRole('region', { name: 'Scopes' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Info', exact: true }).click();
      await expect(page.locator('[data-editor-region="inspector"]')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await recordGate(page, testInfo, viewport, 'reduced-motion');
    });
  });
}

/** 200% browser zoom halves the CSS viewport and doubles the pixel ratio. */
async function zoomedPage(browser: Browser, viewport: Viewport, baseURL: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: viewport.width / 2, height: viewport.height / 2 },
    deviceScaleFactor: 2,
    baseURL,
  });
  return context.newPage();
}

for (const viewport of VIEWPORTS.filter((v) => v.dockColumn)) {
  test(`200% browser zoom: every primary action still reachable — ${viewport.name}`, async ({
    browser,
  }, testInfo) => {
    hostedOnly(testInfo);
    const page = await zoomedPage(browser, viewport, String(testInfo.project.use.baseURL));
    try {
      await openEditor(page);
      await expectPrimaryActionsReachable(page);
      await page.getByRole('button', { name: 'Info', exact: true }).click();
      await expect(page.locator('[data-editor-region="inspector"]')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await recordGate(
        page,
        testInfo,
        { name: `${viewport.name}-200pct`, width: viewport.width / 2, height: viewport.height / 2 },
        'pointer-200pct-zoom',
      );
    } finally {
      await page.context().close();
    }
  });
}

test('touch: tools and compare by tap — phone', async ({ browser }, testInfo) => {
  hostedOnly(testInfo);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    baseURL: String(testInfo.project.use.baseURL),
  });
  const page = await context.newPage();
  try {
    await openEditor(page);
    const dock = page.getByRole('navigation', { name: 'Editor tools' });
    const color = dock.getByRole('button', { name: 'Color', exact: true });
    const box = (await color.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(color).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('slider', { name: 'Tint', exact: true })).toBeVisible();
    const compare = page.getByRole('button', { name: 'Toggle before/after', exact: true });
    const cbox = (await compare.boundingBox())!;
    await page.touchscreen.tap(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
    await expect(compare).toHaveAttribute('aria-pressed', 'true');
    await expectNoHorizontalOverflow(page);
    await recordGate(page, testInfo, { name: 'phone', width: 390, height: 844 }, 'touch');
  } finally {
    await context.close();
  }
});
