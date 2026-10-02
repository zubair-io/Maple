import { expect, test, type Page, type BrowserContext, type Route } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function authFixture(page: Page, context: BrowserContext, claimed: boolean) {
  const session = await context.newCDPSession(page);
  await session.send('WebAuthn.enable');
  await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const challenge = Buffer.alloc(32, 1).toString('base64url');
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let authenticated = false;
  let firstOptions = true;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function registerOptions(route: Route): Promise<void> {
    if (firstOptions) {
      firstOptions = false;
      await pending;
      await route.fulfill({ status: 400, json: { error: 'Invite or registration rejected' } });
      return;
    }
    await route.fulfill({
      json: {
        challenge,
        rp: { id: 'localhost', name: 'Maple QA' },
        user: {
          id: Buffer.from('maple-auth-qa').toString('base64url'),
          name: 'Maple QA',
          displayName: 'Maple QA',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
      },
    });
  }
  const verifyEndpoints = new Set([
    '/api/auth/register/verify',
    '/api/auth/login/verify',
    '/api/auth/dev-login',
  ]);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' && path !== '/api/auth/refresh') {
      requests.push({ path, body: route.request().postDataJSON() });
    }
    if (path === '/api/auth/register/options') {
      await registerOptions(route);
      return;
    }
    if (path === '/api/auth/login/options') {
      await route.fulfill({
        json: { challenge, rpId: 'localhost', userVerification: 'required', timeout: 60000 },
      });
      return;
    }
    if (verifyEndpoints.has(path)) {
      authenticated = true;
      await route.fulfill({
        json: {
          access_token: 'auth-control-contract-token',
          user: { id: 'qa-owner', email: null, role: 'owner' },
        },
      });
      return;
    }
    if (path === '/api/auth/refresh') {
      await route.fulfill(
        authenticated
          ? { json: { access_token: 'auth-control-contract-token' } }
          : { status: 401, json: { error: 'Not signed in' } },
      );
      return;
    }
    const responses = new Map<string, unknown>([
      ['/api/auth/bootstrap', { claimed, dev_login_enabled: false }],
      ['/api/auth/me', { user: { id: 'qa-owner', email: null, role: 'owner' } }],
      ['/api/folders', []],
      ['/api/fs/list', { path: '/', parent: null, entries: [] }],
    ]);
    await route.fulfill({ json: responses.get(path) ?? {} });
  });
  return {
    requests,
    release,
    signOut: () => {
      authenticated = false;
    },
  };
}

for (const width of [1440, 768, 390]) {
  for (const claimed of [true, false]) {
    test(`Self Hosted ${claimed ? 'join and sign-in' : 'claim'} native forms at ${width}px`, async ({
      page,
      context,
    }, testInfo) => {
      test.skip(testInfo.project.name !== 'chrome-self-hosted');
      await page.setViewportSize({ width, height: 900 });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const auth = await authFixture(page, context, claimed);
      try {
        await page.goto(`http://localhost:4419/${claimed ? 'join' : 'sign-in'}`);
        const submit = page.getByRole('button', { name: 'Create passkey', exact: true });
        if (claimed) {
          const code = page.getByRole('textbox', { name: 'Invite code', exact: true });
          await expect(code).toBeVisible();
          await expect(submit).toBeDisabled();
          await code.fill('abc');
          await code.press('Enter');
          expect(auth.requests).toEqual([]);
          await code.fill('abcdefgh');
          await expect(code).toHaveValue('ABCDEFGH');
          await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
          await expect(code).toHaveAttribute('maxlength', '8');
          await code.press('Enter');
        } else {
          await expect(page.getByRole('heading', { name: 'Claim this server' })).toBeVisible();
          await expect(page.getByTestId('dev-sign-in')).toHaveCount(0);
          await submit.focus();
          await submit.press('Enter');
        }
        await expect(submit).toBeDisabled();
        await expect(submit).toHaveAttribute('aria-busy', 'true');
        // Browser keyboard submission must not initiate a second request while busy.
        await page.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
        await expect.poll(() => auth.requests.length).toBe(1);
        auth.release();
        await expect(page.getByRole('alert')).toContainText('Invite or registration rejected');
        await expect(submit).toBeEnabled();
        const overflow = await page.locator('form').evaluate((form) => {
          const bounds = form.getBoundingClientRect();
          return bounds.left < 0 || bounds.right > window.innerWidth;
        });
        expect(overflow).toBe(false);
        for (const control of await page.locator('form button,form input').all()) {
          expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({
          path: testInfo.outputPath(`auth-${claimed ? 'join' : 'claim'}-${width}.png`),
        });
        if (claimed) await page.getByRole('textbox', { name: 'Invite code' }).press('Enter');
        else await submit.press('Space');
        await expect(page).toHaveURL(/\/browse$/);
        const registration = auth.requests.find(
          (request) => request.path === '/api/auth/register/verify',
        );
        expect(registration?.body.device_label).toBe('Web');
        expect(registration?.body.invite_code).toBe(claimed ? 'ABCDEFGH' : undefined);
        expect(registration?.body.credential).toMatchObject({
          type: 'public-key',
          response: { attestationObject: expect.any(String) },
        });
        if (claimed) {
          auth.signOut();
          await page.goto('http://localhost:4419/sign-in?returnUrl=%2Fbrowse');
          const signIn = page.getByRole('button', { name: 'Sign in with a passkey' });
          await signIn.focus();
          await signIn.press('Enter');
          await expect(page).toHaveURL(/\/browse$/);
          const login = auth.requests.find((request) => request.path === '/api/auth/login/verify');
          expect(login?.body.credential).toMatchObject({
            type: 'public-key',
            response: { authenticatorData: expect.any(String), signature: expect.any(String) },
          });
        }
        auth.signOut();
        await page.route('**/api/auth/bootstrap', (route) =>
          route.fulfill({ json: { claimed: true, dev_login_enabled: true } }),
        );
        await page.goto('http://localhost:4419/sign-in?returnUrl=%2Fbrowse');
        const dev = page.getByRole('button', { name: 'Sign in as dev (no passkey)' });
        await dev.focus();
        await dev.press('Enter');
        await expect(page).toHaveURL(/\/browse$/);
        expect(
          auth.requests.find((request) => request.path === '/api/auth/dev-login')?.body,
        ).toEqual({});
        expect(errors).toEqual([]);
      } finally {
        auth.release();
      }
    });
  }
}
