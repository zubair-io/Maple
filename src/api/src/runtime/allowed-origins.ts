/** Browser origins this server accepts for its two origin-gated ceremonies:
 * the WebAuthn passkey check (`auth/webauthn.ts`) and the events WebSocket
 * CSWSH defence (`routes/events.ts`, #863). Both lists must agree, so they
 * share this module rather than parsing `MAPLE_ORIGIN` twice.
 *
 * `MAPLE_ORIGIN` stays an environment variable because the public identity
 * origin has to be known before the database is reachable. The managed LAN
 * HTTPS hostname is a runtime setting instead (Settings → Network, #3474),
 * so it is read from the live listener here — an operator who configures a
 * hostname in the UI can sign in at it without editing a deploy variable and
 * restarting the container (#3519).
 */
import { managedHttps } from '../network/managed-https.ts';

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:4200', 'http://localhost:4201'];

function configuredOrigins(): string[] {
  const raw = process.env.MAPLE_ORIGIN;
  if (!raw) return DEV_ORIGINS;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/** The managed listener's origin exactly as a browser reports it, or null
 * while no certificate is serving. A browser omits the port when it is the
 * scheme default, so `https://host:443` would never match a real request. */
export function managedHttpsOrigin(): string | null {
  const endpoint = managedHttps.endpoint();
  if (!endpoint) return null;
  return endpoint.port === 443
    ? `https://${endpoint.ip}`
    : `https://${endpoint.ip}:${endpoint.port}`;
}

/** `MAPLE_ORIGIN` (or the dev localhost ports) plus the managed HTTPS origin
 * while that listener is serving. Trusting it needs no extra check: only an
 * owner can set the hostname, and it is only advertised once Let's Encrypt
 * has issued a certificate proving control of that exact name. */
export function allowedBrowserOrigins(): string[] {
  const configured = configuredOrigins();
  const managed = managedHttpsOrigin();
  return managed && !configured.includes(managed) ? [...configured, managed] : configured;
}
