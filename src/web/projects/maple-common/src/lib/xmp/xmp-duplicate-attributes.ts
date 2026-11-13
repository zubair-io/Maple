// Read-side repair for a start tag that repeats an attribute (#5475). No
// imports: the Bun API imports this file for its thumbnail develop.

export interface DuplicateAttributeRepair {
  /** The document with every repeated attribute removed. */
  readonly xml: string;
  /** Qualified names that were repeated, once each, in document order. */
  readonly removed: readonly string[];
}

interface Removal {
  readonly start: number;
  readonly end: number;
}

const TAG_NAME = /<[^ \t\r\n/>!?]+/y;
const ATTRIBUTE = /[ \t\r\n]+([^ \t\r\n=/>]+)[ \t\r\n]*=[ \t\r\n]*(?:"[^"]*"|'[^']*')/y;
const TAG_END = /[ \t\r\n]*\/?>/y;

function stickyMatch(pattern: RegExp, xml: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(xml);
}

/** Offset past the comment, CDATA, PI or end tag at `lt`; -1 for a start tag; undefined if unterminated. */
function skipNonStartTag(xml: string, lt: number): number | undefined {
  const skipTo = (terminator: string, from: number): number | undefined => {
    const end = xml.indexOf(terminator, from);
    return end < 0 ? undefined : end + terminator.length;
  };
  if (xml.startsWith('<!--', lt)) return skipTo('-->', lt + 4);
  if (xml.startsWith('<![CDATA[', lt)) return skipTo(']]>', lt + 9);
  if (xml.startsWith('<?', lt)) return skipTo('?>', lt + 2);
  if (xml.startsWith('</', lt)) return skipTo('>', lt + 2);
  return -1;
}

/** Records the start tag's repeated attributes; returns the offset past it, or undefined if it cannot be tokenized. */
function scanStartTag(
  xml: string,
  lt: number,
  removals: Removal[],
  removed: Set<string>,
): number | undefined {
  const name = stickyMatch(TAG_NAME, xml, lt);
  if (!name) return undefined;
  const seen = new Set<string>();
  let at = lt + name[0].length;
  for (let attr = stickyMatch(ATTRIBUTE, xml, at); attr; attr = stickyMatch(ATTRIBUTE, xml, at)) {
    const qualifiedName = attr[1];
    if (seen.has(qualifiedName)) {
      removals.push({ start: at, end: at + attr[0].length });
      removed.add(qualifiedName);
    }
    seen.add(qualifiedName);
    at += attr[0].length;
  }
  const end = stickyMatch(TAG_END, xml, at);
  return end ? at + end[0].length : undefined;
}

/**
 * Remove every repeat of an attribute name within one start tag, keeping the
 * first occurrence (each Maple writer emits the model's value before any
 * passthrough copy, and the canonical sort is stable, so the first copy is
 * the edit). Returns undefined when nothing repeats, or when the markup is
 * too malformed to tokenize (a DOCTYPE, an unterminated comment or tag);
 * callers then keep the parser's original error.
 */
export function removeDuplicateAttributes(xml: string): DuplicateAttributeRepair | undefined {
  const removals: Removal[] = [];
  const removed = new Set<string>();
  for (let lt = xml.indexOf('<'); lt >= 0; ) {
    const skipped = skipNonStartTag(xml, lt);
    if (skipped === undefined) return undefined;
    const next = skipped >= 0 ? skipped : scanStartTag(xml, lt, removals, removed);
    if (next === undefined) return undefined;
    lt = xml.indexOf('<', next);
  }
  if (removals.length === 0) return undefined;
  const kept = removals.reduceRight(
    (text, { start, end }) => text.slice(0, start) + text.slice(end),
    xml,
  );
  return { xml: kept, removed: [...removed] };
}
