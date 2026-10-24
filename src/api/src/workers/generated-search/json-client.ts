export interface JsonClient {
  generateJson(prompt: string, schema: unknown): Promise<unknown>;
}

/** Just the slice of `fetch` the adapters use. Narrower than `typeof fetch`
 * on purpose: the full signature carries overloads a test stub cannot
 * satisfy, and widening the stubs with casts would hide real mismatches. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
