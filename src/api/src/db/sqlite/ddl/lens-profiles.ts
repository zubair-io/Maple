/**
 * `lens_profiles` — imported Adobe lens-correction profiles (.lcp), stored whole.
 *
 * This is the one table in the schema that replaces a GridFS bucket rather than
 * a collection. On MongoDB the bytes lived in `lens_profiles.files` +
 * `lens_profiles.chunks`, because a profile may exceed the 16 MiB document
 * ceiling; SQLite has no such ceiling worth working around here, so the whole
 * file is one BLOB and the two-collection split disappears.
 *
 * ## The digest is the identity, and it is verified on both sides of the wire
 *
 * A profile is addressed by the BLAKE3 hash of its own bytes, which is what
 * `lensProfileDigest` extracts from the `lcp1:<hex>` reference an XMP sidecar
 * carries. So the content IS the key: re-importing the same file is a no-op
 * rather than a second row, and a stored blob whose bytes stop hashing to its
 * own key is corruption rather than an update. `lens-profiles/cache.ts` re-hashes
 * on the way in and on the way out for exactly that reason.
 *
 * ## Why there is no length column and no upload date
 *
 * GridFS's file document carried `length`, `uploadDate`, `filename` and
 * `metadata`. Only two of those have a reader: `filename` was the digest, which
 * is the primary key here, and `metadata` was the inventory. `length` is
 * `length(bytes)`, and nothing has ever read `uploadDate` — so neither becomes a
 * column. A column no code reads is a column the importer has to invent a value
 * for.
 *
 * ## Why this keeps its rowid
 *
 * Every other singleton-ish table in this schema is `WITHOUT ROWID`, which is
 * right for a narrow row that fits in the index page. A row here is up to 32 MiB.
 * In a `WITHOUT ROWID` table the whole payload lives in the primary-key b-tree,
 * so a lookup by digest would page through the blob's overflow chain to find its
 * neighbours; with a rowid table the unique index on `digest` is narrow and the
 * blob sits in overflow pages the seek never touches.
 */

export const LENS_PROFILES_TABLE_DDL = `
CREATE TABLE lens_profiles (
  -- BLAKE3 of \`bytes\`, lowercase hex. The \`lcp1:<hex>\` reference in an XMP
  -- sidecar names a profile by this value.
  digest    TEXT NOT NULL PRIMARY KEY CHECK (length(digest) = 64),

  -- The .lcp file, verbatim. Bounded by MAX_LCP_BYTES at the route, not here:
  -- a CHECK on length would reject a profile an older server had accepted, and
  -- the migration must carry across what is already stored.
  bytes     BLOB NOT NULL,

  -- LensProfileInventory as the core reported it at import: the reference, the
  -- make/camera/lens names and the sample count the picker renders.
  inventory TEXT NOT NULL CHECK (json_valid(inventory))
);
`;
