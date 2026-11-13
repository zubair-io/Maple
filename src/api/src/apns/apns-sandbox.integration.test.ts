import { describe, expect, it } from 'bun:test';
import { Http2ApnsTransport } from './apns-http2-transport.ts';

const enabled = process.env['MAPLE_TEST_APNS_SANDBOX'] === '1';

describe.skipIf(!enabled)('APNs sandbox (opt-in, needs network)', () => {
  it('speaks HTTP/2 and rejects a request with no provider token as MissingProviderToken', async () => {
    const transport = new Http2ApnsTransport();
    try {
      const res = await transport.post(
        'https://api.sandbox.push.apple.com/3/device/00',
        {
          'apns-topic': 'app.justmaple.aperture.pushkit.fileprovider',
          'content-type': 'application/json',
        },
        '{}',
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ reason: 'MissingProviderToken' });
    } finally {
      transport.close();
    }
  });
});
