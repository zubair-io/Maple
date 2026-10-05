import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('connection pages deployment restricts three paths and disables request persistence', async () => {
	const config = JSON.parse(
		(await readFile(new URL('../wrangler.drive-connect.jsonc', import.meta.url), 'utf8')).replace(
			/,\s*([}\]])/g,
			'$1',
		),
	);
	assert.equal(config.name, 'maple-drive-connect-pages');
	assert.equal(config.main, 'src/index.ts');
	assert.equal(config.vars.ORIGIN_BASE_URL, 'https://hornbeam.blob.core.windows.net/mapleaperture');
	assert.equal(config.workers_dev, false);
	assert.equal(config.preview_urls, false);
	assert.equal(config.observability.enabled, false);
	assert.equal(config.logpush, false);
	assert.equal(config.upload_source_maps, false);
	assert.deepEqual(
		config.routes,
		['mapleeditor.com', 'maple-editor.com', 'mapleaperture.com'].map((host) => ({
			pattern: `https://${host}/connect/google-drive*`,
			zone_name: host,
		})),
	);
	assert.deepEqual(Object.keys(config.vars), ['ORIGIN_BASE_URL']);
	assert.equal(config.account_id, undefined);
});

test('protected deployment validates both bundles and deploys pages before accepting relay callbacks', async () => {
	const workflow = await readFile(
		new URL('../../../../.github/workflows/deploy-drive-connect.yml', import.meta.url),
		'utf8',
	);
	assert.match(workflow, /environment: production/);
	assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
	const pageDryRun = workflow.indexOf(
		'wrangler deploy --config wrangler.drive-connect.jsonc --dry-run',
	);
	const relayDryRun = workflow.indexOf('wrangler deploy --dry-run');
	const pageDeploy = workflow.indexOf('wrangler deploy --config wrangler.drive-connect.jsonc\n');
	const relayDeploy = workflow.indexOf('run: npm run deploy');
	assert.ok(pageDryRun >= 0 && relayDryRun >= 0);
	assert.ok(pageDeploy > pageDryRun && pageDeploy > relayDryRun);
	assert.ok(relayDeploy > pageDeploy);
	assert.ok(workflow.indexOf('node scripts/prepare-deploy-secrets.mjs') < pageDeploy);
	assert.match(workflow, /RELAY_SIGNING_KEY: \$\{\{ secrets\.RELAY_SIGNING_KEY \}\}/);
	assert.match(
		workflow,
		/npm run deploy -- --secrets-file "\$RUNNER_TEMP\/drive-relay-secrets\.json"/,
	);
	assert.match(workflow, /Remove temporary deployment secret\n\s+if: always\(\)/);
	assert.doesNotMatch(workflow, /wrangler secret list/);
});
