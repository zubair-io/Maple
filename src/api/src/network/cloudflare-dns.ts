/** Scoped DNS-01 operations: only our exact TXT record IDs are deleted. */
import { setTimeout as delay } from 'node:timers/promises';
import type { ManagedHttpsConfig } from './managed-https-config.ts';

export class CloudflareDns {
  constructor(
    private readonly config: Pick<ManagedHttpsConfig, 'zone_id' | 'api_token' | 'hostname'>,
  ) {}

  private async request(path: string, method = 'GET', body?: object): Promise<unknown> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.api_token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    // Never propagate Cloudflare response bodies or authenticated request objects.
    if (method === 'DELETE' && response.status === 404) return null;
    if (!response.ok) throw new Error(`Cloudflare DNS request failed (HTTP ${response.status}).`);
    const envelope = (await response.json()) as { success?: boolean; result?: unknown };
    if (!envelope.success)
      throw new Error('Cloudflare rejected the DNS request. Check the token permissions and zone.');
    return envelope.result;
  }

  async checkZone(): Promise<void> {
    const zone = (await this.request(this.config.zone_id)) as { name?: string };
    if (
      !zone.name ||
      !(this.config.hostname === zone.name || this.config.hostname.endsWith(`.${zone.name}`))
    )
      throw new Error('The hostname does not belong to the configured Cloudflare zone.');
  }

  async create(value: string): Promise<string> {
    const record = (await this.request(`${this.config.zone_id}/dns_records`, 'POST', {
      type: 'TXT',
      name: `_acme-challenge.${this.config.hostname}`,
      content: value,
      ttl: 60,
    })) as { id?: string };
    if (!record.id || !/^[a-f0-9]{32}$/i.test(record.id))
      throw new Error('Cloudflare returned an invalid DNS record ID.');
    return record.id;
  }

  async remove(zoneId: string, id: string): Promise<void> {
    if (!/^[a-f0-9]{32}$/i.test(zoneId) || !/^[a-f0-9]{32}$/i.test(id))
      throw new Error('Invalid challenge record ID.');
    await this.request(`${zoneId}/dns_records/${id}`, 'DELETE');
  }

  /** Public recursive DNS avoids a LAN split-horizon resolver hiding the TXT.
   * ACME itself remains the final authority on domain control. */
  async waitForPropagation(value: string): Promise<void> {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', `_acme-challenge.${this.config.hostname}`);
    url.searchParams.set('type', 'TXT');
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/dns-json' },
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
          if (body.Answer?.some((answer) => answer.type === 16 && answer.data === `"${value}"`))
            return;
        }
      } catch {
        // Resolver timeouts and malformed responses are transient; keep the
        // bounded propagation retry window instead of abandoning the order.
      }
      await delay(5000);
    }
    throw new Error('DNS challenge propagation timed out. Check public DNS and retry.');
  }
}
