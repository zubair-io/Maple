import { expect, test as base } from '@playwright/test';
import { readProductionFixtureManifest } from './production-fixtures';

interface BrowserAudit {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
  readonly errorResponses: string[];
}

const EXPECTED_SELF_HOSTED_BOOTSTRAP_401 =
  /^401 (?:GET http:\/\/127\.0\.0\.1:\d+\/api\/(?:render|observability)\/config|POST http:\/\/127\.0\.0\.1:\d+\/api\/auth\/refresh)$/;
const CHROME_RESOURCE_401 =
  'Failed to load resource: the server responded with a status of 401 (Unauthorized)';

function unexpectedAuditEntries(
  project: string,
  audit: BrowserAudit,
  expectedConsoleErrorPrefixes: readonly string[],
  expectedRequestFailurePrefixes: readonly string[],
  expectedErrorResponsePrefixes: readonly string[],
): string[] {
  const entries = [
    ...audit.consoleErrors
      .filter((value) => project !== 'chrome-self-hosted' || value !== CHROME_RESOURCE_401)
      .filter((value) => !expectedConsoleErrorPrefixes.some((prefix) => value.startsWith(prefix)))
      .map((value) => `console: ${value}`),
    ...audit.pageErrors.map((value) => `page: ${value}`),
    ...audit.failedRequests
      .filter((value) => !expectedRequestFailurePrefixes.some((prefix) => value.startsWith(prefix)))
      .map((value) => `request: ${value}`),
    ...audit.errorResponses
      .filter(
        (value) =>
          (project !== 'chrome-self-hosted' || !EXPECTED_SELF_HOSTED_BOOTSTRAP_401.test(value)) &&
          !expectedErrorResponsePrefixes.some((prefix) => value.startsWith(prefix)),
      )
      .map((value) => `response: ${value}`),
  ];
  return entries;
}

export const test = base.extend<{ browserAudit: void }>({
  browserAudit: [
    async ({ page }, use, testInfo) => {
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
        process.env.MAPLE_E2E_HOSTED_ARTIFACT_ONLY === '1'
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
            .filter(({ type, description }) => type === 'expected-request-failure' && description)
            .map(({ description }) => description!),
          testInfo.annotations
            .filter(({ type, description }) => type === 'expected-error-response' && description)
            .map(({ description }) => description!),
        ),
        'Production browser emitted unexpected errors; see production-browser-audit.json',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
