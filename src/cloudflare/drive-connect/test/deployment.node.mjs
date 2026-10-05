import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('../scripts/prepare-deploy-secrets.mjs', import.meta.url);
const client = {
	clientId: '12345678-managed.apps.googleusercontent.com',
	clientSecret: 'test-client-secret',
};
function prepare(file, key, credentials = client, credentialFile) {
	const env = { ...process.env };
	delete env.RELAY_SIGNING_KEY;
	delete env.GOOGLE_CLIENT_ID;
	delete env.GOOGLE_CLIENT_SECRET;
	if (credentials) {
		env.GOOGLE_CLIENT_ID = credentials.clientId;
		env.GOOGLE_CLIENT_SECRET = credentials.clientSecret;
	}
	if (key !== undefined) env.RELAY_SIGNING_KEY = key;
	return spawnSync(
		process.execPath,
		[script.pathname, file, ...(credentialFile ? [credentialFile] : [])],
		{
			env,
			encoding: 'utf8',
		},
	);
}
function fixture(run) {
	const directory = mkdtempSync(join(tmpdir(), 'maple-relay-secrets-'));
	try {
		run(join(directory, 'secrets.json'));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test('first deployment writes routing and client secrets with private permissions and no output', () => {
	fixture((file) => {
		const key = randomBytes(32).toString('base64url');
		const result = prepare(file, key);
		assert.equal(result.status, 0);
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, '');
		assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
			RELAY_SIGNING_KEY: key,
			GOOGLE_CLIENT_ID: client.clientId,
			GOOGLE_CLIENT_SECRET: client.clientSecret,
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

test('missing and malformed Google credentials fail before writing without exposing values', () => {
	for (const credentials of [null, { ...client, clientId: 'bad' }, { ...client, clientSecret: '' }])
		fixture((file) => {
			const result = prepare(file, randomBytes(32).toString('base64url'), credentials);
			assert.notEqual(result.status, 0);
			assert.throws(() => statSync(file));
			assert.ok(!`${result.stdout}${result.stderr}`.includes(client.clientSecret));
		});
});

test('downloaded Web client JSON is read privately and requires the canonical registered redirect', () => {
	fixture((file) => {
		const credentialFile = `${file}.client`;
		const web = {
			client_id: client.clientId,
			client_secret: client.clientSecret,
			auth_uri: 'https://accounts.google.com/o/oauth2/auth',
			token_uri: 'https://oauth2.googleapis.com/token',
			redirect_uris: ['https://mapleeditor.com/api/connect/google-drive/callback'],
		};
		writeFileSync(credentialFile, JSON.stringify({ web }));
		const result = prepare(file, randomBytes(32).toString('base64url'), null, credentialFile);
		assert.equal(result.status, 0);
		assert.equal(result.stdout + result.stderr, '');
		assert.equal(JSON.parse(readFileSync(file, 'utf8')).GOOGLE_CLIENT_SECRET, client.clientSecret);
		rmSync(file);
		for (const invalid of [
			{ installed: web },
			{ web: { ...web, redirect_uris: [] } },
			{ web: { ...web, token_uri: 'https://evil.test/token' } },
		]) {
			writeFileSync(credentialFile, JSON.stringify(invalid));
			const failure = prepare(file, randomBytes(32).toString('base64url'), null, credentialFile);
			assert.notEqual(failure.status, 0);
			assert.throws(() => statSync(file));
			assert.ok(!`${failure.stdout}${failure.stderr}`.includes(client.clientSecret));
		}
	});
});
