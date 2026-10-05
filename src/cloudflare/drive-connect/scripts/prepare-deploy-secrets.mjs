import { writeFileSync } from 'node:fs';

// Provision the first real Worker and its routing secret in one Wrangler upload.
// Keep the secret out of argv, logs, artifacts and the source checkout.
const destination = process.argv[2];
const key = process.env.RELAY_SIGNING_KEY;
if (!destination) throw new Error('Deployment secrets file path required');
if (!key || Buffer.byteLength(key, 'utf8') < 32)
	throw new Error('Provide a random production RELAY_SIGNING_KEY of at least 32 bytes');
writeFileSync(destination, JSON.stringify({ RELAY_SIGNING_KEY: key }), {
	encoding: 'utf8',
	mode: 0o600,
	flag: 'wx',
});
