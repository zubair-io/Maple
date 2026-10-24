import { expect, test } from '../support/production-test';
import { openDisposableHostedEditor, sha256File } from '../support/production-editor-actions';

test('Hosted editor dock exposes only working, intentional panel actions', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const { rawPath, originalHash } = await openDisposableHostedEditor(page, 'editor-action-panels');
  await expect(page.locator('editor-image-canvas canvas[data-gpu-live]')).toBeVisible();
  const dock = page.getByRole('navigation', { name: 'Editor tools' });
  await expect(dock).toBeVisible();

  // Optics has no dock entry at all (#2531 — Apple has no equivalent button).
  await expect(dock.getByText('Optics', { exact: true })).toHaveCount(0);
  await dock.getByRole('button', { name: 'Mask', exact: true }).click();
  await expect(page.getByTestId('mask-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add linear mask' })).toBeEnabled();
  await dock.getByRole('button', { name: 'Heal', exact: true }).click();
  await expect(page.getByTestId('retouch-panel')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Size' })).toBeVisible();

  await dock.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(dock.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible();

  // HSL and B&W no longer have dock buttons of their own (#2531) — they are
  // sub-tool chips inside the Colour flyout panel's segmented control, which
  // deliberately uses `aria-pressed` rather than the WAI-ARIA tabs pattern
  // (control-card.component.html — three reviewers flagged the former
  // role="tablist"/role="tab" markup as accessibility-incomplete).
  await dock.getByRole('button', { name: 'Color', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Tint' })).toBeVisible();
  const colorSubtools = page.getByRole('group', { name: 'Color sub-tools' });
  await colorSubtools.getByRole('button', { name: 'HSL', exact: true }).click();
  await expect(page.getByTestId('editor-subparam-row')).toBeVisible();
  await expect(
    page.getByTestId('editor-subparam-row').getByText('H Red', { exact: true }),
  ).toBeVisible();

  await colorSubtools.getByRole('button', { name: 'B&W', exact: true }).click();
  const blackWhite = page.getByRole('switch', { name: 'Black & White' });
  await expect(blackWhite).toHaveAttribute('aria-checked', 'false');
  await blackWhite.click();
  await expect(blackWhite).toHaveAttribute('aria-checked', 'true');
  await expect(colorSubtools.getByRole('button', { name: 'HSL', exact: true })).toHaveCount(0);
  await blackWhite.click();
  await expect(blackWhite).toHaveAttribute('aria-checked', 'false');

  // Colour Grading's real group is Effects (#2531 review correction), so its
  // chip lives in the Effects sub-tool row, not Colour's.
  await dock.getByRole('button', { name: 'Effects', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Dehaze' })).toBeVisible();
  const effectsSubtools = page.getByRole('group', { name: 'Effects sub-tools' });
  await effectsSubtools.getByRole('button', { name: 'Grade', exact: true }).click();
  await expect(page.getByTestId('color-grading-panel')).toBeVisible();
  for (const zone of ['Shadows', 'Midtones', 'Highlights', 'Global']) {
    await expect(
      page.getByRole('application', { name: new RegExp(`^${zone} colour wheel`) }),
    ).toBeVisible();
  }

  await dock.getByRole('button', { name: 'Detail', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Sharpen' })).toBeVisible();

  await dock.getByRole('button', { name: 'Light', exact: true }).click();
  await dock.getByRole('button', { name: 'Tone Curve', exact: true }).click();
  await expect(page.getByTestId('tone-curve-panel')).toBeVisible();
  await expect(page.getByRole('application', { name: /Luma tone curve/ })).toBeVisible();
  await dock.getByRole('button', { name: 'Tone Curve', exact: true }).click();
  await expect(page.getByTestId('tone-curve-panel')).toHaveCount(0);

  await dock.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(page.getByTestId('crop-toolbar')).toBeVisible();
  const squareAspect = page
    .getByTestId('crop-toolbar')
    .locator('button[role="listitem"]')
    .filter({ hasText: '1:1' });
  await expect(squareAspect).toBeEnabled();
  await squareAspect.click();
  await expect(squareAspect).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Reset crop' })).toBeEnabled();
  await page.getByRole('button', { name: 'Reset crop' }).click();
  await page.getByRole('button', { name: 'Done cropping' }).click();
  await expect(page.getByTestId('crop-toolbar')).toHaveCount(0);

  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await exposure.focus();
  await exposure.press('ArrowRight');
  await dock.getByRole('button', { name: 'Presets', exact: true }).click();
  const presets = page.getByTestId('presets-panel');
  await expect(presets).toBeVisible();
  await page.getByRole('textbox', { name: 'New preset name' }).fill('Action audit');
  await page.getByTestId('preset-save').click();
  const savedPresets = presets.locator('mui-presets-panel').last();
  const savedRow = savedPresets
    .locator('[data-testid^="preset-apply-"]')
    .filter({ hasText: 'Action audit' });
  await expect(savedRow).toBeVisible();
  await savedRow.getByRole('button', { name: 'Delete preset' }).click();
  await savedPresets.getByRole('button', { name: 'Cancel delete' }).click();
  await expect(savedRow).toBeVisible();
  await savedRow.getByRole('button', { name: 'Delete preset' }).click();
  await savedPresets.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(savedRow).toHaveCount(0);
  await presets
    .locator('mui-presets-panel')
    .first()
    .locator('[data-testid^="preset-apply-"]')
    .filter({ hasText: 'Flat' })
    .click();
  await expect(presets).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Contrast' })).toHaveAttribute(
    'aria-valuenow',
    '-50',
  );

  expect(await sha256File(rawPath)).toBe(originalHash);
});
