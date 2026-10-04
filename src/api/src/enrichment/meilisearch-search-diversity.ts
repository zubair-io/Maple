/** Bounded reading diversity for #2386. Original rank/scores/membership remain
 * authoritative; only the first ordinary 100-hit page may be permuted. */
import { meilisearchHttp, type MeilisearchTransportConfig } from './meilisearch-transport.ts';
import { MeilisearchSearchError } from './meilisearch-search-error.ts';

interface Hit {
  id: string;
  _rankingScore?: number;
  _matchesPosition?: Record<string, unknown[]>;
}
export interface MeiliSearchResponse {
  hits: Hit[];
  estimatedTotalHits: number;
}
const HEAD_SIZE = 100;
const CONTENT_FIELDS = ['transcript', 'ocrText', 'description', 'placeText'];
const matches = (hit: Hit, field: string): boolean =>
  Array.isArray(hit._matchesPosition?.[field]) && hit._matchesPosition![field]!.length > 0;

function diversify(hits: Hit[]): Hit[] {
  // Explicit filename intent wins; only a head already crowded by actual
  // person-field matches needs diversity. Semantic-only hits cannot attest a
  // literal reading, nor can a caption that also matches the person's name.
  if (
    hits.length < 2 ||
    !hits.slice(0, 2).every((h) => matches(h, 'people') && !matches(h, 'filename'))
  )
    return hits;
  const content = hits
    .filter(
      (h) =>
        !matches(h, 'people') &&
        !matches(h, 'filename') &&
        CONTENT_FIELDS.some((f) => matches(h, f)),
    )
    .slice(0, 2);
  if (!content.length) return hits;
  const ids = new Set(content.map((h) => h.id));
  const remaining = hits.filter((h) => !ids.has(h.id));
  return [remaining[0]!, content[0]!, remaining[1]!, ...content.slice(1), ...remaining.slice(2)];
}

export async function searchWithReadingDiversity(
  config: MeilisearchTransportConfig,
  indexName: string,
  request: Record<string, unknown>,
): Promise<MeiliSearchResponse> {
  const offset = request.offset as number;
  const limit = request.limit as number;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) {
    throw new MeilisearchSearchError(400, 'Invalid search pagination');
  }
  const search = async (
    start: number,
    size: number,
    positions: boolean,
  ): Promise<MeiliSearchResponse> => {
    const result = await meilisearchHttp<MeiliSearchResponse>(
      config,
      'POST',
      `/indexes/${indexName}/search`,
      {
        ...request,
        offset: start,
        limit: size,
        ...(positions ? { showMatchesPosition: true } : {}),
      },
    );
    if (!result.ok || !result.body)
      throw new MeilisearchSearchError(result.status, result.errorText);
    return result.body;
  };
  // None of these requests can consume the permuted head. Preserve the
  // original wire request and avoid gathering unused match metadata. Positions
  // do not identify which term matched, so only a single unpunctuated word
  // can establish alternative readings of the same term.
  if (
    offset >= HEAD_SIZE ||
    limit === 0 ||
    typeof request.q !== 'string' ||
    !/^\p{L}[\p{L}\p{M}\p{N}]*$/u.test(request.q.trim())
  ) {
    return search(offset, limit, false);
  }
  // The same permutation is recomputed for every page. Never insert a new ID
  // on page one and leave its old occurrence behind on subsequent pages.
  const head = await search(0, HEAD_SIZE, true);
  const reordered = diversify(head.hits);
  const prefix = reordered.slice(offset, Math.min(offset + limit, HEAD_SIZE));
  const tailStart = Math.max(offset, HEAD_SIZE);
  const tailSize = Math.max(0, offset + limit - tailStart);
  const tail =
    tailSize > 0 && head.hits.length === HEAD_SIZE
      ? await search(tailStart, tailSize, false)
      : null;
  return {
    hits: [...prefix, ...(tail?.hits ?? [])],
    estimatedTotalHits: head.estimatedTotalHits,
  };
}
