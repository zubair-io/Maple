import { loadNetworkConfig } from './network-config.repo.ts';
import { loadHttpsConfig } from './managed-https-config.ts';

/** Browser navigation is allowed to private HTTPS hosts, but never plaintext LAN. */
export function validatePublicOrigin(raw: string): string {
  const url = new URL(raw.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'Use an HTTPS origin without a path, query or credentials (HTTP is allowed only for loopback)',
    );
  }
  return url.origin;
}
export async function loadPublicOrigin(): Promise<string | null> {
  const network = await loadNetworkConfig();
  if (network?.public_origin) return validatePublicOrigin(network.public_origin);
  const https = await loadHttpsConfig();
  return https.enabled && https.hostname
    ? validatePublicOrigin(`https://${https.hostname}${https.port === 443 ? '' : `:${https.port}`}`)
    : null;
}
