/**
 * Error type + raw-response helpers for `parse-vision-json.ts`. Split out so
 * the orchestrator stays under the file-size budget (#114).
 *
 * `VisionParseError` is thrown by `parseVisionJson` on any deviation from
 * the qwen2.5-vl JSON contract. The runtime persists `err.message` into
 * `stages.describe.last_error`, which the dead-letter triage UI surfaces —
 * so the message is intentionally compact (truncated raw preview) and the
 * full snippet stays on the `snippet` field for programmatic readers.
 */

/** Maximum bytes of the raw response we attach to error messages. Mongo
 * docs can hold MBs, but the dead-letter list is human-triaged in a UI
 * — keep messages bounded so the operator's terminal doesn't choke. */
const MAX_ERROR_SNIPPET_BYTES = 8 * 1024;

/** Short prefix of the raw snippet to embed in `error.message`. The stage
 * runtime persists only `err.message` into `stages.<name>.last_error`,
 * so this is what an operator sees in the dead-letter triage UI without
 * having to crack open the dead-letter doc. Full snippet stays available
 * on the `snippet` field for programmatic readers. */
const MESSAGE_SNIPPET_BYTES = 240;

/** Markdown fence patterns qwen2.5-vl emits with surprising regularity.
 * Conservative: only strip a single matching fence pair, not arbitrary
 * code blocks within prose. */
const FENCE_OPEN = /^\s*```(?:json|JSON)?\s*\n?/;
const FENCE_CLOSE = /\n?```\s*$/;

/** Reason for the parse failure — useful for dead-letter triage grouping. */
export type VisionParseReason =
  | 'not-json'
  | 'not-object'
  | 'missing-field'
  | 'wrong-type'
  | 'bad-enum'
  | 'empty-response';

export class VisionParseError extends Error {
  readonly reason: VisionParseReason;
  readonly field: string | null;
  /** Truncated raw response — capped at `MAX_ERROR_SNIPPET_BYTES`. */
  readonly snippet: string;

  constructor(
    reason: VisionParseReason,
    message: string,
    raw: string,
    field: string | null = null,
  ) {
    const snippet = truncateBytes(raw, MAX_ERROR_SNIPPET_BYTES);
    const preview = truncateBytes(raw, MESSAGE_SNIPPET_BYTES);
    super(`vision-parse[${reason}${field ? `:${field}` : ''}]: ${message} | raw: ${preview}`);
    this.name = 'VisionParseError';
    this.reason = reason;
    this.field = field;
    this.snippet = snippet;
  }
}

/** Byte-aware truncation. `String.slice` cuts UTF-16 code units, so a
 * multi-byte character near the boundary would let the result exceed
 * `maxBytes` — important because the snippet caps Mongo last_error +
 * dead-letter doc growth, not a character count. */
function truncateBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  // toString on an arbitrary byte boundary may leave a half-character at
  // the end — fine for human inspection.
  return buf.subarray(0, maxBytes).toString('utf8') + '…[truncated]';
}

/** Strip a single matching markdown fence pair, if present. Leaves
 * raw input alone when there isn't one. */
export function stripFences(raw: string): string {
  const openMatch = FENCE_OPEN.exec(raw);
  if (!openMatch) return raw;
  const closeMatch = FENCE_CLOSE.exec(raw);
  if (!closeMatch) return raw; // open without close — let JSON.parse fail
  return raw.slice(openMatch[0].length, raw.length - closeMatch[0].length);
}

/** Strip a fence wrapper if present and return the JSON body the parser
 * would consume. Exposed so callers (the describe stage) can compute
 * `raw_response_size` against the same string the parser saw, rather
 * than against the pre-strip text. */
export function strippedRawFor(raw: string): string {
  return stripFences(raw.trim()).trim();
}
