/** Owns a second listener; the IP/Cloudflare Tunnel listener stays available
 * during issuance, renewal, configuration changes and certificate failures. */
import { randomUUID } from 'node:crypto';
import { loadHttpsConfig, type ManagedHttpsConfig } from './managed-https-config.ts';
import {
  claimCertificateLease,
  releaseCertificateLease,
  renewCertificateLease,
  readCertificateState,
  writeCertificateState,
  renewalTime,
  type StoredCertificate,
  type DnsChallengeRecord,
} from './certificate-store.ts';
import { CloudflareDns } from './cloudflare-dns.ts';
import { forgetChallenge } from './certificate-store.ts';
import { issueCertificate } from './issue-certificate.ts';

export interface HttpsStatus {
  state: 'disabled' | 'pending' | 'issuing' | 'ready' | 'error';
  expires_at: number | null;
  retry_at: number | null;
  error: string | null;
  http3: boolean;
}
export interface HttpsEndpoint {
  ip: string;
  port: number;
  scheme: 'https';
}
export interface HttpsListener {
  stop: () => void;
}
export type HttpsListenerFactory = (
  config: ManagedHttpsConfig,
  cert: StoredCertificate,
) => HttpsListener;

export class ManagedHttps {
  private factory?: HttpsListenerFactory;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private listener?: HttpsListener;
  private active?: { config: ManagedHttpsConfig; cert: StoredCertificate };
  private stopped = true;
  private currentStatus: HttpsStatus = {
    state: 'disabled',
    expires_at: null,
    retry_at: null,
    error: null,
    http3: false,
  };

  status(): HttpsStatus {
    return { ...this.currentStatus };
  }
  endpoint(): HttpsEndpoint | null {
    const active = this.active;
    return active && active.cert.not_after > Date.now()
      ? {
          ip: active.config.hostname,
          port: active.config.port,
          scheme: 'https',
        }
      : null;
  }
  start(factory: HttpsListenerFactory): void {
    this.stop();
    this.factory = factory;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.refresh();
    }, 30_000);
    this.timer.unref();
    void this.refresh();
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.closeListener();
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.reconcile()
      .catch(() => {
        this.currentStatus = {
          ...this.currentStatus,
          state: 'error',
          error:
            'Managed HTTPS could not read or apply its settings. The IP and tunnel listener remains available.',
        };
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private closeListener(): void {
    this.listener?.stop();
    this.listener = undefined;
    this.active = undefined;
  }
  /** Binds `cert` on the configured port. Returns an operator-facing message
   * when the bind fails; a listener that was already serving keeps serving. */
  private activate(config: ManagedHttpsConfig, cert: StoredCertificate): string | null {
    if (
      this.stopped ||
      !this.factory ||
      cert.hostname !== config.hostname ||
      cert.not_after <= Date.now()
    )
      return null;
    const previous = this.active;
    if (
      previous?.cert.cert === cert.cert &&
      previous.config.port === config.port &&
      previous.config.http3 === config.http3
    )
      return null;
    // Only a same-port swap must release the port first. A port change binds
    // the new listener before closing the old one, so a port that cannot bind
    // never interrupts clients on the port that works — reconcile runs every
    // 30 s and would otherwise cut every HTTPS connection on each retry.
    const samePort = previous?.config.port === config.port;
    if (samePort) this.closeListener();
    try {
      const listener = this.factory(config, cert);
      if (!samePort) this.closeListener();
      this.listener = listener;
      this.active = { config, cert };
      return null;
    } catch (error) {
      if (samePort) this.restoreListener(previous, config.hostname);
      const reason = error instanceof Error ? error.message : String(error);
      return `Managed HTTPS could not start on port ${config.port}: ${reason} The IP and tunnel listener remains available.`;
    }
  }
  private restoreListener(previous: typeof this.active, hostname: string): void {
    if (!previous || !this.factory) return;
    if (previous.cert.not_after <= Date.now() || previous.config.hostname !== hostname) return;
    try {
      this.listener = this.factory(previous.config, previous.cert);
      this.active = previous;
    } catch {
      // The port was taken between stop and rebind; the next tick retries.
    }
  }
  private async cleanupChallenges(
    config: ManagedHttpsConfig,
    challenges: DnsChallengeRecord[],
  ): Promise<void> {
    if (!challenges.length) return;
    const owner = randomUUID();
    if (!(await claimCertificateLease(owner))) return;
    try {
      const dns = new CloudflareDns(config);
      for (const record of challenges) {
        await dns.remove(record.zone_id, record.id);
        await forgetChallenge(record);
      }
    } catch {
      this.currentStatus = {
        ...this.currentStatus,
        state: 'error',
        error:
          'HTTPS is available, but DNS challenge cleanup failed. Check the Cloudflare token; Maple will retry.',
      };
    } finally {
      await releaseCertificateLease(owner);
    }
  }
  private closeStaleListener(config: ManagedHttpsConfig): void {
    if (
      this.active &&
      (this.active.config.hostname !== config.hostname || this.active.cert.not_after <= Date.now())
    )
      this.closeListener();
  }
  private updateListener(config: ManagedHttpsConfig, cert: StoredCertificate | undefined): void {
    this.publishListenerStatus(cert, cert ? this.activate(config, cert) : null);
  }
  private publishListenerStatus(cert: StoredCertificate | undefined, bindError: string | null) {
    this.currentStatus = {
      state: bindError ? 'error' : this.endpoint() ? 'ready' : 'pending',
      expires_at: cert?.not_after ?? null,
      retry_at: null,
      error: bindError,
      http3: !!this.active?.config.http3,
    };
  }
  private async reconcile(): Promise<void> {
    const config = await loadHttpsConfig();
    if (this.stopped) return;
    if (!config.enabled) {
      this.closeListener();
      this.currentStatus = {
        state: 'disabled',
        expires_at: null,
        retry_at: null,
        error: null,
        http3: false,
      };
      return;
    }
    this.closeStaleListener(config);
    const stored = await readCertificateState();
    const cert = this.certificateForHostname(stored?.certificate, config.hostname);
    this.updateListener(config, cert);
    if (cert && Date.now() < renewalTime(cert)) {
      // Retry orphaned TXT cleanup without issuing another certificate.
      await this.cleanupChallenges(config, stored?.challenges ?? []);
      return;
    }
    if (this.isRetryDeferred(config, stored)) return;
    await this.renew(config);
  }
  private certificateForHostname(
    cert: StoredCertificate | undefined,
    hostname: string,
  ): StoredCertificate | undefined {
    return cert?.hostname === hostname ? cert : undefined;
  }
  private isRetryDeferred(
    config: ManagedHttpsConfig,
    stored: Awaited<ReturnType<typeof readCertificateState>>,
  ): boolean {
    if (stored?.attempted_revision === config.revision && (stored.retry_after ?? 0) > Date.now()) {
      this.currentStatus = {
        ...this.currentStatus,
        state: 'error',
        retry_at: stored.retry_after ?? null,
        error:
          'Certificate issuance or renewal failed. Check Cloudflare permissions and public DNS. Maple will retry automatically.',
      };
      return true;
    }
    return false;
  }
  private async renew(config: ManagedHttpsConfig): Promise<void> {
    const owner = randomUUID();
    if (!(await claimCertificateLease(owner))) return;
    this.currentStatus = { ...this.currentStatus, state: 'issuing' };
    const heartbeat = setInterval(() => {
      void renewCertificateLease(owner).catch(() => {
        /* Existing lease allows transient DB outages. */
      });
    }, 60_000);
    heartbeat.unref();
    try {
      // Persist the retry window before contacting ACME, including across crashes.
      await writeCertificateState({
        attempted_revision: config.revision,
        retry_after: Date.now() + 3600_000,
      });
      const issued = await issueCertificate(config);
      await writeCertificateState({ certificate: issued, retry_after: 0 });
      const latest = await loadHttpsConfig();
      if (!latest.enabled || latest.hostname !== config.hostname || this.stopped) {
        this.closeListener();
        return;
      }
      // A bind failure after a successful order is a listener problem, not an
      // issuance failure: the certificate is persisted and no retry window applies.
      this.publishListenerStatus(issued, this.activate(latest, issued));
    } catch {
      // ACME/HTTP errors can carry authorization headers, private keys or JWS
      // payloads. Report a safe operational message instead of serializing them.
      this.currentStatus = {
        ...this.currentStatus,
        state: 'error',
        retry_at: Date.now() + 3600_000,
        error:
          'Certificate issuance or renewal failed. Check Cloudflare permissions and public DNS. Maple will retry automatically.',
      };
    } finally {
      clearInterval(heartbeat);
      await releaseCertificateLease(owner);
    }
  }
}
export const managedHttps = new ManagedHttps();
