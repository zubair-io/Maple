import { createHash } from 'node:crypto';
import { expect, test as base, type Request } from '@playwright/test';
import { readProductionFixtureManifest } from './production-fixtures';

interface BrowserAudit {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
  readonly errorResponses: string[];
}

// A subresource (font, script, stylesheet, image, ...) that is still in
// flight when the page navigates to a new document — or when the tab/context
// tears down — gets its loader destroyed by Chromium, which reports it as
// `net::ERR_ABORTED`. That is benign browser behavior, not an application
// bug, so it must not fail the audit. Every OTHER cause of a failed request
// (404, connection refused, CSP block, DNS failure, ...) surfaces as a
// different `errorText` and must keep failing the audit regardless of
// resource type.
//
// `xhr`/`fetch` are excluded from the exemption: those are the only
// resource types the app's own JavaScript can cancel itself, via
// `AbortController`. A `net::ERR_ABORTED` there could be a real bug (a
// component racing its own cleanup and aborting a request it still needed)
// rather than the browser discarding a request superseded by navigation, so
// it stays fatal. Everything else Chrome fetches on the page's behalf
// (`<link>`, `@font-face`, `<script src>`, `<img>`, the navigation document
// itself, ...) has no such app-controlled cancellation path — the browser is
// the only thing that can abort those, and it does so exactly when a
// navigation or teardown discards the document that requested them.
const SELF_ABORTABLE_RESOURCE_TYPES: ReadonlySet<string> = new Set(['xhr', 'fetch']);

function isBenignNavigationAbort(request: Request): boolean {
  return (
    request.failure()?.errorText === 'net::ERR_ABORTED' &&
    !SELF_ABORTABLE_RESOURCE_TYPES.has(request.resourceType())
  );
}

const EXPECTED_SELF_HOSTED_BOOTSTRAP_401 =
  /^401 (?:GET http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/(?:render|observability)\/config|POST http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/auth\/refresh)$/;
const CHROME_RESOURCE_401 =
  'Failed to load resource: the server responded with a status of 401 (Unauthorized)';

function selfHostedTestClientIp(testId: string, retry: number): string {
  const digest = createHash('sha256').update(`${testId}:${retry}`).digest('hex');
  const groups = Array.from({ length: 6 }, (_, index) => digest.slice(index * 4, index * 4 + 4));
  return `2001:db8:${groups.join(':')}`;
}

function unexpectedAuditEntries(
  project: string,
  audit: BrowserAudit,
  expectedConsoleErrorPrefixes: readonly string[],
  expectedResponseErrorPrefixes: readonly string[],
): string[] {
  const entries = [
    ...audit.consoleErrors
      .filter((value) => project !== 'chrome-self-hosted' || value !== CHROME_RESOURCE_401)
      .filter((value) => !expectedConsoleErrorPrefixes.some((prefix) => value.startsWith(prefix)))
      .map((value) => `console: ${value}`),
    ...audit.pageErrors.map((value) => `page: ${value}`),
    ...audit.failedRequests.map((value) => `request: ${value}`),
    ...audit.errorResponses
      .filter(
        (value) =>
          project !== 'chrome-self-hosted' || !EXPECTED_SELF_HOSTED_BOOTSTRAP_401.test(value),
      )
      .filter((value) => !expectedResponseErrorPrefixes.some((prefix) => value.startsWith(prefix)))
      .map((value) => `response: ${value}`),
  ];
  return entries;
}

export const test = base.extend<{ browserAudit: void }>({
  browserAudit: [
    async ({ page }, use, testInfo) => {
      if (testInfo.project.name === 'chrome-self-hosted') {
        // Every Playwright context represents a fresh browser client, but the
        // direct test server otherwise sees all of them as one localhost IP.
        // Emulate the trusted reverse-proxy hop for the rate-limited bootstrap
        // request so one scenario cannot exhaust another scenario's auth
        // bucket. Keep the header off unrelated cross-origin LAN discovery.
        await page.route('**/api/auth/refresh', async (route) => {
          await route.continue({
            headers: {
              ...route.request().headers(),
              'x-forwarded-for': selfHostedTestClientIp(testInfo.testId, testInfo.retry),
            },
          });
        });
      }
      const audit: BrowserAudit = {
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        errorResponses: [],
      };
      page.on('console', (message) => {
        if (message.type() === 'error') audit.consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => audit.pageErrors.push(error.message));
      page.on('requestfailed', (request) => {
        if (isBenignNavigationAbort(request)) return;
        audit.failedRequests.push(
          `${request.method()} ${request.url()} ${request.failure()?.errorText}`,
        );
      });
      page.on('response', (response) => {
        if (response.status() >= 400) {
          audit.errorResponses.push(
            `${response.status()} ${response.request().method()} ${response.url()}`,
          );
        }
      });

      await use();
      const fixtureRoot =
        process.env.MAPLE_E2E_ARTIFACT_ONLY === '1'
          ? undefined
          : (await readProductionFixtureManifest()).root;
      await testInfo.attach('production-browser-audit.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              project: testInfo.project.name,
              baseURL: testInfo.project.use.baseURL,
              fixtureRoot,
              ...audit,
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
      expect(
        unexpectedAuditEntries(
          testInfo.project.name,
          audit,
          testInfo.annotations
            .filter(({ type, description }) => type === 'expected-console-error' && description)
            .map(({ description }) => description!),
          testInfo.annotations
            .filter(({ type, description }) => type === 'expected-response-error' && description)
            .map(({ description }) => description!),
        ),
        'Production browser emitted unexpected errors; see production-browser-audit.json',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
