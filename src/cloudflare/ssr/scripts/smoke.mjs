#!/usr/bin/env node
// Public-endpoint smoke check for the Hosted SSR Worker (#2474 acceptance
// criterion: "Add public-endpoint deployment smoke checks for WASM
// MIME/magic/full bytes, PNG/WOFF2 integrity, headers, and a deep-link SPA
// navigation."). Run this against the live production domain after every
// deploy of the Worker or of a new `dist/maple-syrup/browser` build:
//
//   node scripts/smoke.mjs https://mapleaperture.com
//   npm run smoke -- https://mapleaperture.com
//
// Exits non-zero (and prints every failure, not just the first) on any
// check failure, so it is safe to wire into a deploy pipeline as a gate
// once an operator is ready to add one.
//
// The stable-named asset paths below mirror
// `src/web/scripts/hosted-artifact-contract.ts` and the header contract
// mirrors `src/web/scripts/hosted-security-header-contract.ts` — this
// script is a standalone dev tool with no import path into `src/web`
// (same "keep in sync by hand" convention as `src/security-headers.ts`).

const baseUrl = process.argv[2] ?? 'https://mapleaperture.com';

const WASM_ASSET = '/raw_wasm_bg.wasm';
const PNG_ASSET = '/assets/brand/icon-512.png';
const WOFF2_ASSET = '/assets/fonts/Lato-Regular.woff2';
// A path that cannot exist as a real file, used to prove the SPA fallback
// serves the app shell for a navigation...
const DEEP_LINK_PATH = '/browse/smoke-check-library/does-not-exist';
// ...while a non-navigation request for an equally nonexistent asset still
// gets a real 404 rather than being swallowed by the same fallback.
const MISSING_ASSET_PATH = '/pkg/does-not-exist-smoke-check.js';

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32]; // ASCII "wOF2"

const REQUIRED_HEADERS = {
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-embedder-policy': 'require-corp',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
};

/** @type {string[]} */
const failures = [];

function fail(check, message) {
	failures.push(`${check}: ${message}`);
}

function startsWithMagic(bytes, magic) {
	return magic.every((byte, index) => bytes[index] === byte);
}

async function fetchBytes(path) {
	const response = await fetch(new URL(path, baseUrl));
	const buffer = new Uint8Array(await response.arrayBuffer());
	return { response, buffer };
}

async function checkBinaryAsset(path, expectedContentType, magic, label) {
	const { response, buffer } = await fetchBytes(path);
	if (response.status !== 200) return fail(label, `${path} returned ${response.status}`);
	const contentType = response.headers.get('content-type');
	if (contentType !== expectedContentType) {
		fail(label, `${path} content-type is "${contentType}", expected "${expectedContentType}"`);
	}
	if (!startsWithMagic(buffer, magic)) {
		fail(label, `${path} does not start with the expected magic bytes (got ${buffer.length} bytes)`);
	}
	const declaredLength = response.headers.get('content-length');
	if (declaredLength !== null && Number(declaredLength) !== buffer.length) {
		fail(
			label,
			`${path} body is ${buffer.length} bytes but Content-Length declared ${declaredLength} — truncated or re-encoded in transit`,
		);
	}
	if (buffer.length === 0) fail(label, `${path} body is empty`);
}

async function checkWasm() {
	await checkBinaryAsset(WASM_ASSET, 'application/wasm', WASM_MAGIC, 'wasm');
}

async function checkPng() {
	await checkBinaryAsset(PNG_ASSET, 'image/png', PNG_MAGIC, 'png');
}

async function checkWoff2() {
	// woff2's registered MIME type; browsers also accept font/woff2.
	await checkBinaryAsset(WOFF2_ASSET, 'font/woff2', WOFF2_MAGIC, 'woff2');
}

async function checkHeaders() {
	const response = await fetch(new URL('/', baseUrl));
	for (const [name, expected] of Object.entries(REQUIRED_HEADERS)) {
		const actual = response.headers.get(name);
		if (actual !== expected) {
			fail('headers', `/ is missing "${name}: ${expected}" (got "${actual}")`);
		}
	}
}

async function checkDeepLinkSpaFallback() {
	const response = await fetch(new URL(DEEP_LINK_PATH, baseUrl), {
		headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
	});
	if (response.status !== 200) {
		return fail('spa-fallback', `${DEEP_LINK_PATH} returned ${response.status}, expected 200`);
	}
	const contentType = response.headers.get('content-type') ?? '';
	if (!contentType.includes('text/html')) {
		fail('spa-fallback', `${DEEP_LINK_PATH} content-type is "${contentType}", expected text/html`);
	}
	const body = await response.text();
	if (!body.includes('<html') && !body.toLowerCase().includes('<!doctype html')) {
		fail('spa-fallback', `${DEEP_LINK_PATH} body does not look like the app shell`);
	}
}

async function checkRealMissingAssetIsA404() {
	const response = await fetch(new URL(MISSING_ASSET_PATH, baseUrl), {
		headers: { accept: '*/*' },
	});
	if (response.status !== 404) {
		fail(
			'real-404',
			`${MISSING_ASSET_PATH} returned ${response.status}, expected a real 404 (not the SPA fallback)`,
		);
	}
}

const CHECKS = [
	['wasm', checkWasm],
	['png', checkPng],
	['woff2', checkWoff2],
	['headers', checkHeaders],
	['spa-fallback', checkDeepLinkSpaFallback],
	['real-404', checkRealMissingAssetIsA404],
];

async function main() {
	console.log(`Hosted SSR smoke check against ${baseUrl}`);
	// allSettled, not all: a thrown network error (DNS failure, connection
	// refused, ...) from one check must not abort the rest — every check
	// should get a chance to run and report, same as an ordinary assertion
	// failure recorded via fail() above.
	const results = await Promise.allSettled(CHECKS.map(([, check]) => check()));
	results.forEach((result, index) => {
		if (result.status === 'rejected') {
			const [label] = CHECKS[index];
			fail(label, `threw: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
		}
	});

	if (failures.length > 0) {
		console.error(`\n${failures.length} check(s) failed:`);
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exitCode = 1;
		return;
	}
	console.log('All checks passed.');
}

await main();
