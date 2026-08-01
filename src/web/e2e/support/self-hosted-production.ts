import type { APIResponse, Page } from '@playwright/test';
import { expect } from './production-test';

/** Register a disposable production fixture and enter the real Self Hosted UI. */
export async function openSelfHostedFixture(
  page: Page,
  path: string,
  label: string,
): Promise<void> {
  let login: APIResponse | null = null;
  const attempts: string[] = [];
  for (let attempt = 1; attempt <= 20; attempt++) {
    const response = await page.request.post('/api/auth/dev-login', { data: {} });
    const body = await response.text();
    attempts.push(`attempt ${attempt}: ${response.status()} ${body.slice(0, 500)}`);
    if (response.ok()) {
      login = response;
      break;
    }
    await page.waitForTimeout(250);
  }
  expect(login, `dev-login did not become ready:\n${attempts.join('\n')}`).not.toBeNull();
  const session = (await login!.json()) as { access_token: string };
  const registration = await page.request.post('/api/folders', {
    headers: { Authorization: `Bearer ${session.access_token}` },
    data: { path, label },
  });
  expect(registration.status(), await registration.text()).toBe(201);
  const { slug } = (await registration.json()) as { slug: string };

  await page.goto('/sign-in');
  await page.getByTestId('dev-sign-in').click();
  await page.waitForURL((url) => url.pathname !== '/sign-in');
  const library = page.getByTestId('source-sidebar').getByText(label, { exact: true });
  await expect(library).toBeVisible();
  await library.click();
  await expect(page).toHaveURL(new RegExp(`/browse/${slug}(?:/|$)`));
}
