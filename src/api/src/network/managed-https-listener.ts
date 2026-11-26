import type { Elysia } from 'elysia';
import { LISTENER_IDLE_TIMEOUT_SECONDS, MAX_REQUEST_BODY_BYTES } from '../runtime/tls-config.ts';
import type { HttpsListenerFactory } from './managed-https.ts';

/** Separate app instance keeps Elysia's WebSocket server context bound to
 * the right listener. Bun reload() only replaces handlers, not TLS keys. */
export function httpsListenerFactory(createApp: () => Elysia): HttpsListenerFactory {
  return (config, cert) => {
    if (config.http3 && Bun.semver.order(Bun.version, '1.4.2') < 0)
      throw new Error('Managed HTTP/3 requires Bun 1.4.2 or newer.');
    const secureApp = createApp();
    const options = {
      port: config.port,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      idleTimeout: LISTENER_IDLE_TIMEOUT_SECONDS,
      tls: { cert: cert.cert, key: cert.key },
      http3: config.http3,
    };
    secureApp.listen(options);
    return {
      stop: () => {
        void secureApp.server?.stop(true);
      },
    };
  };
}
