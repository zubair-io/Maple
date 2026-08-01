import { defineConfig, devices } from '@playwright/test';

const configOnly = process.env.MAPLE_E2E_CONFIG_ONLY === '1';
const artifactOnly = process.env.MAPLE_E2E_ARTIFACT_ONLY === '1';
const hostedPort = process.env.MAPLE_E2E_HOSTED_PORT ?? '4400';
const selfHostedPort = process.env.MAPLE_E2E_SELF_HOSTED_PORT ?? '4401';

const artifactServers = [
  {
    command: `PORT=${hostedPort} bun run serve:hosted-update-e2e`,
    url: `http://127.0.0.1:${hostedPort}`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  },
  {
    command:
      `DIST=dist/maple/browser PORT=${selfHostedPort} ` +
      'API_UNAVAILABLE_STATUS=401 MAPLE_HOSTED_SECURITY_POLICY=0 ' +
      'MAPLE_E2E_SELF_HOSTED_CACHE_FIXTURES=1 ' +
      'bun scripts/serve-dist-coep.mjs',
    url: `http://127.0.0.1:${selfHostedPort}`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  },
];

export default defineConfig({
  testDir: './e2e',
  testMatch: 'production/**/*.spec.ts',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  outputDir: 'test-results/production-chrome',
  globalTeardown:
    configOnly || artifactOnly ? undefined : './e2e/support/production-global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'chrome-hosted',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        baseURL: `http://127.0.0.1:${hostedPort}`,
      },
    },
    {
      name: 'chrome-self-hosted',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        baseURL: `http://127.0.0.1:${selfHostedPort}`,
      },
    },
  ],
  webServer: configOnly
    ? undefined
    : artifactOnly
      ? artifactServers
      : {
          command: 'bun scripts/serve-production-e2e.ts',
          url: `http://127.0.0.1:${hostedPort}`,
          reuseExistingServer: false,
          timeout: 600_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
});
