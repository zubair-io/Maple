import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('../scripts/prepare-deploy-secrets.mjs', import.meta.url);
function prepare(file, key) {
	const env = { ...process.env };
	delete env.RELAY_SIGNING_KEY;
	if (key !== undefined) env.RELAY_SIGNING_KEY = key;
	return spawnSync(process.execPath, [script.pathname, file], {
		env,
		encoding: 'utf8',
	});
}
function fixture(run) {
	const directory = mkdtempSync(join(tmpdir(), 'maple-relay-secrets-'));
	try {
		run(join(directory, 'secrets.json'));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test('first deployment writes only the routing secret with private permissions and no output', () => {
	fixture((file) => {
		const key = randomBytes(32).toString('base64url');
		const result = prepare(file, key);
		assert.equal(result.status, 0);
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, '');
		assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
			RELAY_SIGNING_KEY: key,
		});
		if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
	});
});

test('missing and short secrets fail before any deployment file exists without printing the value', () => {
	for (const key of [undefined, randomBytes(8).toString('base64url')])
		fixture((file) => {
			const result = prepare(file, key);
			assert.notEqual(result.status, 0);
			assert.throws(() => statSync(file));
			if (key) assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
		});
});

test('existing deployment files cannot be overwritten', () => {
	fixture((file) => {
		writeFileSync(file, 'keep existing bytes');
		const key = randomBytes(32).toString('base64url');
		const result = prepare(file, key);
		assert.notEqual(result.status, 0);
		assert.equal(readFileSync(file, 'utf8'), 'keep existing bytes');
		assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
	});
});

test('a preexisting symlink cannot redirect secret output', () => {
	fixture((file) => {
		const target = `${file}.target`;
		writeFileSync(target, 'unrelated bytes');
		symlinkSync(target, file);
		assert.notEqual(prepare(file, randomBytes(32).toString('base64url')).status, 0);
		assert.equal(readFileSync(target, 'utf8'), 'unrelated bytes');
	});
});
