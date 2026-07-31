import { expect, test as base } from '@playwright/test';
import { readProductionFixtureManifest } from './production-fixtures';

interface BrowserAudit {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
  readonly errorResponses: string[];
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
      const manifest = await readProductionFixtureManifest();
      await testInfo.attach('production-browser-audit.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              project: testInfo.project.name,
              baseURL: testInfo.project.use.baseURL,
              fixtureRoot: manifest.root,
              ...audit,
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
    },
    { auto: true },
  ],
});

export { expect };
