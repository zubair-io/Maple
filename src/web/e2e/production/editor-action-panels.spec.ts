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

  for (const [label, ticket] of [
    ['Optics', '#1534'],
    ['Mask', '#1541'],
    ['Heal', '#1472'],
  ] as const) {
    const action = dock.getByRole('button', { name: label, exact: true });
    await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute('title', new RegExp(`coming in ${ticket}`));
  }

  await dock.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Light', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible();

  await dock.getByRole('button', { name: 'Color', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Tint' })).toBeVisible();
  await dock.getByRole('button', { name: 'Effects', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Dehaze' })).toBeVisible();
  await dock.getByRole('button', { name: 'Detail', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Sharpen' })).toBeVisible();

  await dock.getByRole('button', { name: 'HSL', exact: true }).click();
  await expect(page.getByTestId('editor-subparam-row')).toBeVisible();
  await expect(page.getByRole('button', { name: 'H Red' })).toBeVisible();

  await dock.getByRole('button', { name: 'B&W', exact: true }).click();
  const blackWhite = page.getByRole('switch', { name: 'Black & White' });
  await expect(blackWhite).toHaveAttribute('aria-checked', 'false');
  await blackWhite.click();
  await expect(blackWhite).toHaveAttribute('aria-checked', 'true');
  await expect(dock.getByRole('button', { name: 'HSL', exact: true })).toHaveCount(0);
  await blackWhite.click();
  await expect(blackWhite).toHaveAttribute('aria-checked', 'false');

  await dock.getByRole('button', { name: 'Light', exact: true }).click();
  await dock.getByRole('button', { name: 'Curve', exact: true }).click();
  await expect(page.getByTestId('tone-curve-panel')).toBeVisible();
  await expect(page.getByRole('application', { name: /Luma tone curve/ })).toBeVisible();
  await dock.getByRole('button', { name: 'Curve', exact: true }).click();
  await expect(page.getByTestId('tone-curve-panel')).toHaveCount(0);

  await dock.getByRole('button', { name: 'Grade', exact: true }).click();
  await expect(page.getByTestId('color-grading-panel')).toBeVisible();
  for (const zone of ['Shadows', 'Midtones', 'Highlights', 'Global']) {
    await expect(
      page.getByRole('application', { name: new RegExp(`^${zone} colour wheel`) }),
    ).toBeVisible();
  }

  await dock.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(page.getByTestId('crop-toolbar')).toBeVisible();
  const squareAspect = page.getByRole('radio', { name: 'Aspect 1:1' });
  await expect(squareAspect).toBeEnabled();
  await squareAspect.click();
  await expect(squareAspect).toHaveAttribute('aria-checked', 'true');
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
  await expect(page.getByRole('button', { name: 'Apply preset Action audit' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete preset Action audit' }).click();
  await page.getByRole('button', { name: 'Cancel delete' }).click();
  await expect(page.getByRole('button', { name: 'Delete preset Action audit' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete preset Action audit' }).click();
  await page.getByRole('button', { name: 'Confirm delete Action audit' }).click();
  await expect(page.getByRole('button', { name: 'Apply preset Action audit' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Apply preset Flat' }).click();
  await expect(presets).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Contrast' })).toHaveAttribute(
    'aria-valuenow',
    '-50',
  );

  expect(await sha256File(rawPath)).toBe(originalHash);
});
