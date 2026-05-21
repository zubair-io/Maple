/**
 * RFC 6266 / RFC 5987 `Content-Disposition` header builder.
 *
 * Filenames come from the indexed filesystem and may contain bytes that
 * would otherwise produce a malformed header (`"`), enable response
 * splitting (`\r`/`\n`), or render as mojibake (non-ASCII). We emit both
 * the quoted-string ASCII fallback (legacy clients) AND the `filename*`
 * UTF-8/percent-encoded form (RFC 5987), in that order. Modern clients
 * prefer `filename*`; older clients fall back to `filename`.
 *
 * - The ASCII fallback drops every byte < 0x20 (incl. CR / LF / NUL) and
 *   DEL, escapes `\` and `"`, and replaces non-ASCII with `_` so the
 *   quoted-string is always 7-bit safe and free of response-splitting
 *   bytes.
 * - The UTF-8 (`filename*`) form runs the original string through
 *   `encodeURIComponent` plus the extra characters RFC 5987's
 *   `attr-char` grammar requires to be percent-encoded — control bytes
 *   end up as `%01`…`%1F` rather than being stripped, which is still
 *   safe in a header value because the percent-encoding escapes them.
 */

/**
 * Percent-encode per RFC 5987 `value-chars`. `encodeURIComponent` leaves
 * `! * ' ( ) ~` unencoded, but RFC 5987 disallows them in `attr-char`,
 * so we percent-encode them explicitly.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!~]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Reduce `value` to a 7-bit ASCII quoted-string-safe form:
 *   - drop bytes < 0x20 and DEL (0x7F)
 *   - replace non-ASCII with `_`
 *   - escape `\` → `\\` and `"` → `\"`
 *
 * The CR/LF/NUL strip is redundant once we drop everything < 0x20, but
 * keep the comment as documentation: the response-splitting concern is
 * neutralised at this step.
 */
function asciiFallback(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      // Strip control bytes (incl. CR / LF / NUL).
      continue;
    }
    if (code > 0x7e) {
      // Non-ASCII — collapse to underscore; UTF-8 form carries the
      // real glyph via filename*.
      out += "_";
      continue;
    }
    if (ch === "\\" || ch === '"') {
      out += "\\" + ch;
      continue;
    }
    out += ch;
  }
  // Strip leading/trailing whitespace that survived the loop.
  return out.trim();
}

/**
 * Build a hardened `Content-Disposition: attachment; …` header value.
 *
 * Emits `filename="…"` (ASCII fallback) first, then `filename*=UTF-8''…`
 * (RFC 5987 percent-encoded). Parameters are semicolon-separated per
 * RFC 6266 §4.1.
 */
export function buildContentDispositionAttachment(filename: string): string {
  const fallback = asciiFallback(filename) || "download";
  const encoded = encodeRfc5987(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
