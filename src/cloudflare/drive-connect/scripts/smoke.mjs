// Read-only release probe. Never sends a real Google code, ticket or token.
const hosts = ['mapleeditor.com', 'maple-editor.com', 'mapleaperture.com'];
const failures = [];
for (const host of hosts) {
  for (const path of ['/connect/google-drive', '/connect/google-drive/return']) {
    try {
      const response = await fetch(`https://${host}${path}?ngsw-bypass=true`, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) throw new Error('static page unavailable');
      if (!response.headers.get('cache-control')?.includes('no-store') || !response.headers.get('cache-control')?.includes('no-transform')) throw new Error('uncached HTML integrity policy missing');
      if (response.headers.get('referrer-policy') !== 'no-referrer' || !response.headers.get('content-security-policy')?.includes("worker-src 'none'")) throw new Error('connection security headers missing');
      const html = await response.text();
      if (/cloudflareinsights|beacon\.min\.js|googletagmanager|google-analytics|zaraz/i.test(html)) throw new Error('analytics injection detected');
      if (!/<app-root[\s>]/.test(html) || !/src="[^" ]*main[^" ]*\.js"/.test(html)) throw new Error('Hosted Angular shell missing');
      console.log(`${host}${path}: static security policy passed`);
    } catch (error) { failures.push(`${host}${path}: ${error.message}`); }
  }
  for (const [path, expected] of [['unknown', 404], ['start', 405]]) {
    try {
      const response = await fetch(`https://${host}/api/connect/google-drive/${path}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (response.status !== expected || response.headers.get('content-type')?.includes('text/html')) throw new Error(`expected real ${expected} API response`);
      console.log(`${host}/api/connect/google-drive/${path}: routing passed`);
    } catch (error) { failures.push(`${host}/api/connect/google-drive/${path}: ${error.message}`); }
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
