import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { r2Client, r2Endpoint, type ResolvedCloudflareConfig } from './r2-client.ts';
import { BACKUP_PREFIX, backupTimestamp } from './backup-key.ts';
import type { SnapshotInfo } from './backup-snapshot.ts';

function xmlValues(xml: string, name: string): string[] {
  const values: string[] = [];
  const parser = new SaxesParser({ xmlns: true });
  let active = false;
  let text = '';
  parser.on('opentag', (tag) => {
    active = tag.local === name;
    if (active) text = '';
  });
  parser.on('text', (value) => {
    if (active) text += value;
  });
  parser.on('closetag', (tag) => {
    if (tag.local === name) values.push(text);
    active = false;
  });
  parser.write(xml).close();
  return values;
}

const escapeXml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!,
  );

export class BackupR2 {
  private readonly client;
  constructor(private readonly config: ResolvedCloudflareConfig) {
    this.client = r2Client(config);
  }

  private async request(
    key: string,
    init: RequestInit = {},
    query?: URLSearchParams,
  ): Promise<Response> {
    const url = new URL(r2Endpoint(this.config, key.split('/').map(encodeURIComponent).join('/')));
    if (query) url.search = query.toString();
    const response = await this.client.fetch(url.toString(), {
      ...init,
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`R2 ${init.method ?? 'GET'} failed (${response.status})`);
    }
    return response;
  }

  async upload(key: string, path: string, info: SnapshotInfo, version: string): Promise<void> {
    const headers = {
      'content-type': 'application/gzip',
      'x-amz-meta-schema-version': info.schema,
      'x-amz-meta-uncompressed-size': String(info.bytes),
      'x-amz-meta-sha256': info.sha256,
      'x-amz-meta-maple-version': version,
    };
    const file = Bun.file(path);
    if (file.size <= 64 * 1024 * 1024) {
      await this.request(key, { method: 'PUT', headers, body: await file.arrayBuffer() });
      return;
    }
    const started = await this.request(
      key,
      { method: 'POST', headers },
      new URLSearchParams({ uploads: '' }),
    );
    const uploadId = xmlValues(await started.text(), 'UploadId')[0];
    if (!uploadId) throw new Error('R2 multipart response omitted upload ID');
    try {
      const parts: string[] = [];
      const partSize = Math.max(64 * 1024 * 1024, Math.ceil(file.size / 10_000));
      for (let offset = 0; offset < file.size; offset += partSize) {
        const part = parts.length + 1;
        const response = await this.request(
          key,
          { method: 'PUT', body: await file.slice(offset, offset + partSize).arrayBuffer() },
          new URLSearchParams({ uploadId, partNumber: String(part) }),
        );
        const etag = response.headers.get('etag');
        if (!etag) throw new Error('R2 multipart response omitted ETag');
        parts.push(`<Part><PartNumber>${part}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`);
      }
      const completed = await this.request(
        key,
        {
          method: 'POST',
          body: `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`,
          headers: { 'content-type': 'application/xml' },
        },
        new URLSearchParams({ uploadId }),
      );
      const xml = await completed.text();
      if (!xmlValues(xml, 'ETag').length || xmlValues(xml, 'Code').length)
        throw new Error('R2 multipart completion failed');
    } catch (error) {
      await this.request(key, { method: 'DELETE' }, new URLSearchParams({ uploadId })).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async confirm(key: string, checksum: string): Promise<void> {
    if (backupTimestamp(key) === null) throw new Error('Invalid Maple backup key');
    await this.request(`${key}.verified`, { method: 'PUT', body: checksum });
  }

  async download(key: string): Promise<Response> {
    if (backupTimestamp(key) === null) throw new Error('Invalid Maple backup key');
    return this.request(key);
  }

  async list(): Promise<string[]> {
    const keys: string[] = [];
    const present = new Set<string>();
    const seen = new Set<string>();
    let token = '';
    do {
      const query = new URLSearchParams({ 'list-type': '2', prefix: BACKUP_PREFIX });
      if (token) query.set('continuation-token', token);
      const xml = await (await this.request('', {}, query)).text();
      for (const objectKey of xmlValues(xml, 'Key')) present.add(objectKey);
      keys.push(
        ...xmlValues(xml, 'Key')
          .filter((key) => key.endsWith('.verified'))
          .map((key) => key.slice(0, -9))
          .filter((key) => backupTimestamp(key) !== null),
      );
      if (xmlValues(xml, 'IsTruncated')[0] !== 'true')
        return keys.filter((key) => present.has(key));
      token = xmlValues(xml, 'NextContinuationToken')[0] ?? '';
      if (!token || seen.has(token)) throw new Error('Invalid R2 listing continuation');
      seen.add(token);
    } while (token);
    return keys;
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.some((key) => backupTimestamp(key) === null))
      throw new Error('Refusing to delete a non-backup key');
    const objects = keys.flatMap((key) => [key, `${key}.verified`]);
    for (let offset = 0; offset < objects.length; offset += 1000) {
      const body = `<Delete><Quiet>true</Quiet>${objects
        .slice(offset, offset + 1000)
        .map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`)
        .join('')}</Delete>`;
      const response = await this.request(
        '',
        {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/xml',
            'content-md5': createHash('md5').update(body).digest('base64'),
          },
        },
        new URLSearchParams({ delete: '' }),
      );
      const xml = await response.text();
      if (xmlValues(xml, 'Code').length)
        throw new Error('R2 failed to delete one or more expired backups');
    }
  }
}
