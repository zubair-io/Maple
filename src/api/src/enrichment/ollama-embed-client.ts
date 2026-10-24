export interface EmbedTarget {
  url: string;
  model: string;
  /** Wire protocol of `url`; absent means Ollama. */
  protocol?: 'ollama' | 'openai';
  apiKey?: string | null;
}

export const EMBED_BATCH_SIZE = 512;

// Ollama applies the keep-alive of the latest request, so -1 pins the model against idle unloads.
const EMBED_KEEP_ALIVE = -1;

// Sized for a cold model load plus a full 512-document batch queued behind another on a slow host.
const EMBED_REQUEST_TIMEOUT_MS = 300_000;

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

/** OpenAI's `/embeddings` answers `data: [{ index, embedding }]`, which need not be in input order. */
function openAiEmbeddings(body: unknown): unknown {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  return [...(data as Array<{ index?: unknown; embedding?: unknown }>)]
    .sort((a, b) => Number(a?.index) - Number(b?.index))
    .map((entry) => entry?.embedding);
}

function parseEmbeddings(body: unknown, expected: number, protocol: string): number[][] {
  const embeddings =
    protocol === 'openai'
      ? openAiEmbeddings(body)
      : (body as { embeddings?: unknown } | null)?.embeddings;
  const valid =
    Array.isArray(embeddings) &&
    embeddings.length === expected &&
    embeddings.every(
      (vector) =>
        Array.isArray(vector) &&
        vector.length > 0 &&
        vector.every((value) => typeof value === 'number' && Number.isFinite(value)),
    );
  if (!valid)
    throw new Error(`${protocol} embed returned a malformed response for ${expected} inputs`);
  return embeddings as number[][];
}

/** Scales a vector to unit length and rounds it to f32, the precision it is stored at. */
export function l2Normalize(vector: readonly number[]): Float32Array {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) throw new Error('ollama embed returned a zero vector');
  return Float32Array.from(vector, (value) => value / norm);
}

/** Little-endian f32 bytes, independent of the host's byte order. */
export function encodeVector(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: bytes.byteLength / 4 }, (_, index) =>
    view.getFloat32(index * 4, true),
  );
}

function embedRequest(target: EmbedTarget, inputs: readonly string[]): [string, RequestInit] {
  const base = target.url.replace(/\/+$/u, '');
  const signal = AbortSignal.timeout(EMBED_REQUEST_TIMEOUT_MS);
  if (target.protocol !== 'openai') {
    return [
      `${base}/api/embed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: target.model, input: inputs, keep_alive: EMBED_KEEP_ALIVE }),
        signal,
      },
    ];
  }
  return [
    `${base}/embeddings`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: target.model, input: inputs }),
      signal,
    },
  ];
}

/** One embedding call for up to `EMBED_BATCH_SIZE` texts; returns unit-length vectors in input order. */
export async function embedTexts(
  target: EmbedTarget,
  inputs: readonly string[],
  fetchImpl: FetchImpl = fetch,
): Promise<Float32Array[]> {
  const protocol = target.protocol ?? 'ollama';
  const response = await fetchImpl(...embedRequest(target, inputs));
  if (!response.ok) throw new Error(`${protocol} embed answered ${response.status}`);
  return parseEmbeddings(await response.json(), inputs.length, protocol).map(l2Normalize);
}
