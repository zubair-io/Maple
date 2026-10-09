import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const policy = {
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-embedder-policy': 'require-corp',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
};
const assets = {
	'/pkg/raw_wasm_bg.wasm': ['application/wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 255])],
	'/assets/brand/icon-512.png': ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255])],
	'/assets/fonts/Lato-Regular.woff2': ['font/woff2', Buffer.from([119, 79, 70, 50, 0, 255])],
	'/ngsw.json': ['application/json', Buffer.from('{"hashTable":{}}')],
};

async function runSmoke(change = () => {}, changeOrigin = () => {}) {
	function serve(rewrite) {
		return createServer((request, response) => {
			const path = new URL(request.url, 'http://localhost').pathname;
			const asset = assets[path];
			const missing = path === '/pkg/does-not-exist-smoke-check.js';
			const result = {
				status: missing ? 404 : 200,
				headers: {
					...policy,
					'content-type': asset?.[0] ?? 'text/html',
					'cache-control': asset || missing ? 'no-cache' : 'no-cache, no-transform',
				},
				body: asset?.[1] ?? Buffer.from(missing ? 'missing' : '<html>Maple</html>'),
			};
			rewrite(path, result, request);
			response.writeHead(result.status, result.headers);
			response.end(result.body);
		});
	}
	const edge = serve(change);
	const origin = serve(changeOrigin);
	const servers = [edge, origin];
	try {
		await Promise.all(
			servers.map(async (server) => {
				server.listen(0, '127.0.0.1');
				await once(server, 'listening');
			}),
		);
		const url = (server) => `http://127.0.0.1:${server.address().port}`;
		const child = spawn(process.execPath, [
			new URL('../scripts/smoke.mjs', import.meta.url).pathname,
			url(edge),
			url(origin),
		]);
		const output = [];
		child.stdout.on('data', (chunk) => output.push(chunk));
		child.stderr.on('data', (chunk) => output.push(chunk));
		const [code] = await once(child, 'close');
		return { code, output: Buffer.concat(output).toString() };
	} finally {
		await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
	}
}

test('CLI proves complete bytes against the origin and accepts valid delivery', async () => {
	const result = await runSmoke();
	assert.equal(result.code, 0, result.output);
	assert.match(result.output, /sha256=/);
});

for (const path of ['/', '/browse/smoke-check-library/does-not-exist']) {
	test(`CLI rejects unguarded or transformed HTML at ${path}`, async () => {
		const unguarded = await runSmoke((requestPath, response) => {
			if (requestPath === path) response.headers['cache-control'] = 'no-cache';
		});
		assert.equal(unguarded.code, 1, unguarded.output);
		assert.match(unguarded.output, /no-transform/);
		const transformed = await runSmoke((requestPath, response) => {
			if (requestPath === path)
				response.body = Buffer.from('<html>Maple<script src="/beacon.js"></script></html>');
		});
		assert.equal(transformed.code, 1, transformed.output);
		assert.match(transformed.output, /HTML SHA-256 differs from origin/);
	});
}

for (const path of Object.keys(assets)) {
	test(`CLI detects equal-length corruption beyond magic bytes: ${path}`, async () => {
		const result = await runSmoke((requestPath, response) => {
			if (requestPath !== path) return;
			response.body = Buffer.from(response.body);
			response.body[response.body.length - 1] ^= 1;
		});
		assert.equal(result.code, 1, result.output);
		assert.match(result.output, /SHA-256 differs from origin/);
	});
}

for (const path of ['/', '/pkg/raw_wasm_bg.wasm', '/browse/smoke-check-library/does-not-exist']) {
	test(`CLI requires security headers on ${path}`, async () => {
		const result = await runSmoke((requestPath, response) => {
			if (requestPath === path) delete response.headers['cross-origin-embedder-policy'];
		});
		assert.equal(result.code, 1, result.output);
		assert.match(result.output, /cross-origin-embedder-policy/);
	});
}

test('CLI fails stale stable-asset and service-worker cache policies', async () => {
	const result = await runSmoke((path, response) => {
		if (path === '/assets/fonts/Lato-Regular.woff2')
			response.headers['cache-control'] = 'max-age=31536000, immutable';
		if (path === '/ngsw.json') response.headers['cache-control'] = 'public, max-age=3600';
	});
	assert.equal(result.code, 1, result.output);
	assert.match(result.output, /immutable/);
	assert.match(result.output, /ngsw.json.*no-cache/);
});

test('CLI rejects wrong font MIME, missing assets masked as 200, and root errors', async () => {
	const result = await runSmoke((path, response) => {
		if (path.endsWith('.woff2')) response.headers['content-type'] = 'application/octet-stream';
		if (path.endsWith('smoke-check.js')) response.status = 200;
		if (path === '/') response.status = 503;
	});
	assert.equal(result.code, 1, result.output);
	assert.match(result.output, /font\/woff2/);
	assert.match(result.output, /expected a real 404/);
	assert.match(result.output, /\/ returned 503/);
});

test('CLI rejects an unavailable origin rather than certifying edge bytes', async () => {
	const result = await runSmoke(
		() => {},
		(path, response) => {
			if (path.endsWith('.wasm')) response.status = 404;
		},
	);
	assert.equal(result.code, 1, result.output);
	assert.match(result.output, /origin.*returned 404/);
});

test('CLI requests the root as an HTML navigation, matching the SPA fallback contract', async () => {
	const result = await runSmoke((path, response, request) => {
		if (path === '/' && request.headers.accept !== 'text/html') response.status = 404;
	});
	assert.equal(result.code, 0, result.output);
});

test('CLI compares decoded compressed bytes to the origin without mistaking wire Content-Length for decoded length', async () => {
	const result = await runSmoke((path, response) => {
		if (path !== '/pkg/raw_wasm_bg.wasm') return;
		response.body = gzipSync(response.body);
		response.headers['content-encoding'] = 'gzip';
		response.headers['content-length'] = String(response.body.length);
	});
	assert.equal(result.code, 0, result.output);
});
