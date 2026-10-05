import { createHash } from 'node:crypto';
import type { GoogleFetch } from './oauth.ts';

const root = 'maple-root';
interface TestFile {
  id: string;
  name: string;
  parents: string[];
  description: string;
  properties?: Record<string, string>;
  size: string;
  sha256Checksum?: string;
  mimeType: string;
  ownedByMe?: boolean;
  driveId?: string;
  bytes: Uint8Array;
}
interface Upload {
  id: string;
  name: string;
  parents: string[];
  description: string;
  properties?: Record<string, string>;
  mimeType: string;
  size: number;
  parts: Uint8Array[];
}
function metadata(file: TestFile) {
  const { bytes: _bytes, ...safe } = file;
  return safe;
}
function uploadedBytes(parts: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
class GoogleStore {
  readonly files = new Map<string, TestFile>();
  readonly requests: Array<{
    method: string;
    path: string;
    query: string | null;
    headers: Headers;
  }> = [];
  private reserve = 0;
  private active: Upload | null = null;
  private loseFinalResponse = false;
  loseFinal() {
    this.loseFinalResponse = true;
  }
  readonly transport: GoogleFetch = async (raw, init) => {
    const url = new URL(raw);
    const method = init?.method ?? 'GET';
    this.requests.push({
      method,
      path: url.pathname,
      query: url.searchParams.get('q'),
      headers: new Headers(init?.headers),
    });
    if (url.pathname === `/drive/v3/files/${root}`) return this.rootMetadata();
    switch (url.pathname) {
      case '/drive/v3/files/generateIds':
        return Response.json({ ids: [`file-${++this.reserve}`] });
      case '/drive/v3/files':
        return this.listFiles(url);
      case '/upload/drive/v3/files':
        return this.uploadRequest(method, init);
      default:
        if (url.pathname.startsWith('/drive/v3/files/')) return this.fileRequest(url, method);
        throw new Error(`Unexpected test request ${method} ${url.pathname}`);
    }
  };
  private rootMetadata() {
    return Response.json({
      id: root,
      name: 'Maple Photo Backup',
      mimeType: 'application/vnd.google-apps.folder',
      ownedByMe: true,
      parents: ['my-drive'],
      description: JSON.stringify({ mapleBackupRoot: 1, identity: 'backup-uuid' }),
    });
  }
  private listFiles(url: URL) {
    const query = url.searchParams.get('q') ?? '';
    const hash = /properties has \{ key='mapleKeyHash' and value='([a-f0-9]{64})' \}/.exec(
      query,
    )?.[1];
    return Response.json({
      files: [...this.files.values()]
        .filter(
          (file) =>
            file.parents.includes(root) && (!hash || file.properties?.['mapleKeyHash'] === hash),
        )
        .map(metadata),
    });
  }
  private fileRequest(url: URL, method: string) {
    const id = url.pathname.split('/').at(-1)!;
    const file = this.files.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (method === 'DELETE') {
      this.files.delete(id);
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(file.bytes));
    return Response.json(metadata(file));
  }
  private uploadRequest(method: string, init?: RequestInit) {
    if (method === 'DELETE') {
      this.active = null;
      return new Response(null, { status: 204 });
    }
    if (method === 'POST') return this.startUpload(init);
    if (method === 'PUT') return this.uploadChunk(init);
    throw new Error(`Unexpected upload method ${method}`);
  }
  private startUpload(init?: RequestInit) {
    this.active = {
      ...JSON.parse(String(init!.body)),
      size: Number(new Headers(init?.headers).get('x-upload-content-length')),
      parts: [],
    };
    return new Response(null, {
      status: 200,
      headers: {
        Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1',
      },
    });
  }
  private uploadChunk(init?: RequestInit) {
    const active = this.active;
    if (!active) return new Response(null, { status: 404 });
    const body = init?.body as Uint8Array | undefined;
    if (body?.length) active.parts.push(body);
    const size = active.parts.reduce((total, part) => total + part.length, 0);
    if (size < active.size)
      return new Response(null, {
        status: 308,
        headers: size ? { Range: `bytes=0-${size - 1}` } : {},
      });
    const bytes = uploadedBytes(active.parts, size);
    this.files.set(active.id, {
      id: active.id,
      name: active.name,
      mimeType: active.mimeType,
      ownedByMe: true,
      parents: active.parents,
      description: active.description,
      properties: active.properties,
      size: String(size),
      sha256Checksum: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    });
    if (this.loseFinalResponse) {
      this.loseFinalResponse = false;
      throw new Error('Simulated lost final response');
    }
    return Response.json(metadata(this.files.get(active.id)!));
  }
}
export const googleStore = () => new GoogleStore();
