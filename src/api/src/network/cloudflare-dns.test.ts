import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { CloudflareDns } from './cloudflare-dns.ts';

const config = {
  hostname: 'local.example.com',
  zone_id: 'a'.repeat(32),
  api_token: 'test-zone-token',
};
const id = 'b'.repeat(32);
let remote: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
beforeEach(() => {
  remote = spyOn(globalThis, 'fetch');
});
afterEach(() => {
  remote.mockRestore();
});

it('validates zone ownership before issuing a certificate', async () => {
  remote.mockResolvedValue(Response.json({ success: true, result: { name: 'other.example' } }));
  await expect(new CloudflareDns(config).checkZone()).rejects.toThrow('does not belong');
});
it('creates only the exact DNS-01 TXT record using the scoped token', async () => {
  remote.mockResolvedValue(Response.json({ success: true, result: { id } }));
  expect(await new CloudflareDns(config).create('challenge-value')).toBe(id);
  const [url, options] = remote.mock.calls[0];
  expect(String(url)).toEndWith(`/zones/${config.zone_id}/dns_records`);
  expect(options?.method).toBe('POST');
  expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${config.api_token}`);
  expect(JSON.parse(String(options?.body))).toEqual({
    type: 'TXT',
    name: '_acme-challenge.local.example.com',
    content: 'challenge-value',
    ttl: 60,
  });
});
it('deletes only the record ID it created and tolerates cleanup already completed', async () => {
  remote.mockResolvedValue(new Response('', { status: 404 }));
  await new CloudflareDns(config).remove(config.zone_id, id);
  expect(String(remote.mock.calls[0][0])).toEndWith(`/dns_records/${id}`);
  expect(remote.mock.calls[0][1]?.method).toBe('DELETE');
});
it('does not expose provider bodies or credentials when an API request fails', async () => {
  remote.mockResolvedValue(new Response('sensitive provider error', { status: 403 }));
  await expect(new CloudflareDns(config).create('value')).rejects.toThrow('HTTP 403');
});
it('waits for the exact public TXT value, rather than trusting the Cloudflare write response', async () => {
  remote.mockResolvedValue(Response.json({ Answer: [{ type: 16, data: '"challenge-value"' }] }));
  await new CloudflareDns(config).waitForPropagation('challenge-value');
  expect(String(remote.mock.calls[0][0])).toContain('name=_acme-challenge.local.example.com');
  expect(new Headers(remote.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
});

it('retries transient resolver and JSON failures until the TXT propagates', async () => {
  remote.mockRejectedValueOnce(new Error('resolver timeout'));
  remote.mockResolvedValueOnce(new Response('invalid json'));
  remote.mockResolvedValueOnce(
    Response.json({ Answer: [{ type: 16, data: '"challenge-value"' }] }),
  );
  await new CloudflareDns(config).waitForPropagation('challenge-value');
  expect(remote).toHaveBeenCalledTimes(3);
}, 15_000);
