#!/usr/bin/env node
// Purges stale Cloudflare edge cache entries for the Hosted production zone
// after a deploy (#2474 acceptance criterion: "Purge stale edge entries
// after deployment."). This is a separate, explicit step from `npm run
// deploy` — deploying new Worker code does not retroactively evict
// responses Cloudflare's zone-level cache already served and stored
// (including, historically, the corrupted binaries the previous
// un-source-controlled Worker produced), so a stale copy can keep being
// served to some clients until either its Cache-Control expires or it is
// purged explicitly.
//
// Requires two operator-supplied credentials (never committed):
//   CF_API_TOKEN  — a Cloudflare API token scoped to "Zone.Cache Purge" for
//                   the target zone; create one at
//                   https://dash.cloudflare.com/profile/api-tokens
//   CF_ZONE_ID    — the zone ID for mapleaperture.com, from the zone's
//                   Overview page in the Cloudflare dashboard
//
//   CF_API_TOKEN=... CF_ZONE_ID=... npm run purge
//
// Purges everything in the zone rather than a URL list — this Worker's own
// responses never carry a stable cache key across deploys (see
// src/index.ts's cache-control passthrough), so a partial purge would need
// to enumerate every build's hashed filenames to be reliable, which a full
// purge makes unnecessary.

const apiToken = process.env.CF_API_TOKEN;
const zoneId = process.env.CF_ZONE_ID;

if (!apiToken || !zoneId) {
	console.error('purge.mjs requires CF_API_TOKEN and CF_ZONE_ID in the environment.');
	console.error('See the header comment in this file for how to obtain them.');
	process.exitCode = 1;
	process.exit();
}

const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
	method: 'POST',
	headers: {
		Authorization: `Bearer ${apiToken}`,
		'Content-Type': 'application/json',
	},
	body: JSON.stringify({ purge_everything: true }),
});

const body = await response.json();

if (!response.ok || body.success !== true) {
	console.error('Cache purge failed:', JSON.stringify(body, null, 2));
	process.exitCode = 1;
} else {
	console.log(`Purged all edge cache entries for zone ${zoneId}.`);
}
