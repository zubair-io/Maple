import { readFileSync, writeFileSync } from 'node:fs';

// Provision the real Worker and its routing/client secrets in one Wrangler upload.
// Keep the secret out of argv, logs, artifacts and the source checkout.
const destination = process.argv[2];
const key = process.env.RELAY_SIGNING_KEY;
if (!destination) throw new Error('Deployment secrets file path required');
if (!key || Buffer.byteLength(key, 'utf8') < 32)
	throw new Error('Provide a random production RELAY_SIGNING_KEY of at least 32 bytes');
function googleClient() {
	const file = process.argv[3];
	if (!file)
		return {
			clientId: process.env.GOOGLE_CLIENT_ID,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET,
		};
	try {
		const web = JSON.parse(readFileSync(file, 'utf8')).web;
		if (
			web?.token_uri !== 'https://oauth2.googleapis.com/token' ||
			web?.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' ||
			!Array.isArray(web.redirect_uris) ||
			!web.redirect_uris.includes('https://mapleeditor.com/api/connect/google-drive/callback')
		)
			throw new Error();
		return { clientId: web.client_id, clientSecret: web.client_secret };
	} catch {
		throw new Error('Provide a Google Web client JSON with the registered Maple callback');
	}
}
const { clientId, clientSecret } = googleClient();
if (
	typeof clientId !== 'string' ||
	!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) ||
	typeof clientSecret !== 'string' ||
	!clientSecret.trim() ||
	clientSecret.length > 2048
)
	throw new Error('Matching Google Web client ID and secret required');
writeFileSync(
	destination,
	JSON.stringify({
		RELAY_SIGNING_KEY: key,
		GOOGLE_CLIENT_ID: clientId,
		GOOGLE_CLIENT_SECRET: clientSecret,
	}),
	{
		encoding: 'utf8',
		mode: 0o600,
		flag: 'wx',
	},
);
