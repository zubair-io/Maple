# DCP bundle split: embed matrices+index, lazy-load HSM pool — design

Ticket: [#828](https://github.com/zubair-io/Maple/issues/828). Foundation: [#829](https://github.com/zubair-io/Maple/issues/829) (v2 format). Blocked-on-for-render-flip: [#825](https://github.com/zubair-io/Maple/issues/825) (HSM application math). Drafted 2026-06-01.

This is a **design** spec — it defines the on-disk layout, the loader refactor, the two delivery paths (web / native), the parity gate, and the sequencing. It does **not** implement the loader.

---

## The load-bearing verdict (read this first)

**The #379 v2 dedup-pool on-disk format is NOT the right foundation for lazy range-fetch as built. It needs three encoding changes. The dedup _pool concept_ is exactly right and is the enabler — the _encoding_ around it is wrong.** Therefore **#829 must land the corrected encoding below, not the whole-stream v2 as built** — landing whole-stream v2 first means #828 immediately has to break the format it inherited.

Why the format-as-built can't support the ticket's acceptance criterion ("per-image render fetches only its body's profile + referenced HSM pool entries"):

The v2 layout (`07e4bc42`, branch `worktree-agent-a56b2c0c5f43cfa7c`; see `src/scripts/convert_dcps.py` module docstring + `parser.rs`) is a **single zlib stream over the entire post-header payload** — `table_count`, then the whole HSM pool, then all N profile records, all concatenated and DEFLATE-compressed as one blob. Two structural consequences make per-body fetch impossible:

1. **No offset directory.** Pool entries are variable-length (each `HsmTable` is `h*s*v*3` f32, dims vary) and stored back-to-back with no index of byte offsets. You cannot compute the byte range of entry N without walking entries 0..N — which requires the decompressed bytes — so you cannot range-fetch a single entry.
2. **One monolithic zlib stream.** Even with offsets, DEFLATE is not seekable: you must inflate from the start of the stream to reach any interior byte. Inflating to reach entry N pulls and decompresses the entire ~24 MB.
3. **The index (records) is nested _inside_ the compressed blob, after the pool.** So even the cheap matrices+index part — the ~263 KB the ticket wants always-resident — is unreachable without downloading and decompressing the full 24 MB.

The only way to consume v2-as-built on web is "download the whole pool once, inflate once." That is exactly the 24 MB transfer the ticket exists to kill — merely moved from inside the `.wasm` to a separate fetch. The acceptance clause "fetches only its body's referenced entries" is the discriminator that breaks the tie, and v2-as-built fails it by construction.

### The three required encoding changes (these are #829's scope)

1. **Hoist the index (profile records) out of the compressed region and into the always-embedded part.** Records (body key → matrices + illuminants + BE-offset + pool-index refs) become a small uncompressed/own section (~263 KB, the matrices+index class). Records reference HSM by pool index exactly as v2 already does — that part is correct.
2. **Add an uncompressed pool offset directory.** `pool_count` entries of `(byte_offset: u32, compressed_len: u32, dims: u16×3, encoding: u8)`. At ~1,193 unique tables × ~16 B ≈ ~19 KB, this is cheap to embed. This is what lets a client compute the exact byte range for pool entry N without touching the pool body.
3. **Compress per-entry, not whole-stream.** Each pool entry is an independent zlib stream so it is independently range-fetchable _and_ independently inflatable. `miniz_oxide` is already linked on all three targets (native, WASM via `png`), so per-entry inflate adds no dependency.

**Asset-size assumption #829 must validate (do not assert it — measure it):** per-entry zlib should still land the pool at ~24–25 MB. Dedup is the heavy lifter (2,162 → 1,193 unique tables); each ~32 KB table already exceeds DEFLATE's 32 KB window, so whole-stream deflate was not exploiting cross-table redundancy post-dedup anyway. If the per-entry total blows materially past ~25 MB, #829 surfaces it and we revisit (e.g. group small entries into range-aligned chunks). The whole #828 web-size win rides on this number; #829's converter must print it.

Everything below assumes this corrected encoding ("v3 split layout"). The v2 dual-version parser plumbing (zlib via miniz_oxide, version-discriminated header, dedup converter) is reused; only the section ordering, the offset directory, and per-entry compression change.

---

## Goals / non-goals

**Goals**

- Web download stays in the ~263 KB class (matrices + index + offset directory); no `.wasm` size regression from HSM.
- Per-image render touches only its body's profile + the ≤2 HSM pool entries it references; those are fetched once and cached.
- Native (Apple FFI, API dylib) maps the asset; the OS pages in only touched entries — also cutting startup memory.
- Pixel parity: native and web identical to today's embedded path (merge gate).

**Non-goals**

- HSM **application** math (valScale tone-coupling, dual-illuminant blend, tier ordering) — that is #825. This spec keeps HSM _resolvable_ but does not change how it is applied, and lands with HSM still **disabled in the render path** (see Sequencing).
- Changing `MapleProfile` / `DcpProfile` / `ProfileCurve` public shapes. The loader resolves to the same `MapleProfile` (with `hsm1`/`hsm2: Option<HsmTable>`) it does today.

---

## 1. On-disk layout (v3 split)

Little-endian throughout. Same `MDCP` magic; header `version = 3`. Conceptually two regions: an **always-resident index region** (embedded everywhere) and a **pool region** (embedded on native; a separate fetchable asset on web).

```
Header (16 bytes, uncompressed)
  [0..4]   magic         b"MDCP"
  [4..6]   version       u16  = 3
  [6..8]   flags         u16  (=0, reserved)
  [8..12]  num_profiles  u32
  [12..16] pool_count    u32  (number of unique HSM pool entries)

Index region (uncompressed; this is the ~263 KB part embedded on all platforms)
  pool_directory: pool_count × {
    offset        u32   byte offset of this entry within the POOL REGION
    compressed_len u32  zlib-stream length of this entry within the POOL REGION
    hsm_h         u16
    hsm_s         u16
    hsm_v         u16
    encoding      u8    0=Linear, 1=sRGB
    reserved      u8    (=0)
  }                      // 16 bytes/entry; ~1,193 × 16 ≈ 19 KB
  records: num_profiles × {
    ucm_len       u16
    ucm           ucm_len bytes (utf-8, no NUL)
    flags         u8    bit0=CM1 bit1=CM2 bit2=FM1 bit3=FM2 bit4=HSM1 bit5=HSM2
    reserved      u8    (=0)
    illum1        u16   DNG CalibrationIlluminant code, 0 if absent
    illum2        u16
    reserved      u16   (=0)
    (each present matrix: 9×f32 = 36 B; order CM1, CM2, FM1, FM2)
    (if HSM1: hsm1_pool_index u32)
    (if HSM2: hsm2_pool_index u32)
    baseline_exposure_offset_bits u32  (IEEE754 f32 bits, 0 if absent)
  }

Pool region (the ~24 MB part; embedded on native, separate fetchable asset on web)
  pool_count × {
    zlib stream of (hsm_h*hsm_s*hsm_v*3) f32  — ONE independent stream per entry
  }
  // entry K occupies pool_region[offset_K .. offset_K + compressed_len_K]
  // dims/encoding for entry K come from the directory, so the inflated f32 count is known
```

**Addressing a body's HSM (the whole point):**

1. Resolve the body's record from the embedded index → get `hsm1_pool_index` / `hsm2_pool_index`.
2. For each index, read `pool_directory[index]` → `(offset, compressed_len, dims, encoding)`.
3. Fetch (web) or slice (native) `pool_region[offset .. offset+compressed_len]`, inflate that one stream, build the `HsmTable` from `(dims, encoding, inflated f32)`.

**Build emits two files** (the converter — #829 — gains a `--split` writer, or the split is the default for v3):

- `profiles.idx` — header + index region. Committed to the repo; embedded via `include_bytes!`; shipped as a small web asset. ~263 KB class.
- `profiles.pool` — the pool region only. Committed (~24 MB, under GitHub's 50 MB warning); embedded on native via `include_bytes!`; served as a static web asset for range fetch.

The directory's `offset` is relative to the start of `profiles.pool`, so the two files are independently addressable. (A single-file variant — index region then pool region in one `profiles.bin`, directory offsets relative to the pool-region start — is acceptable for native and is what the embedded fallback uses; the web path prefers two files so the index isn't re-downloaded with every pool fetch and the SW can cache them with different policies. The converter emits both the combined and split forms from the same in-memory model.)

---

## 2. Loader refactor (`profile_loader`)

Today: `pub(crate) const PROFILES_BIN: &[u8] = include_bytes!(...)`, parsed whole into a `HashMap<CameraKey, MapleProfile>` behind a `OnceLock`, with `hsm1`/`hsm2` already materialized inline. `lookup_profile` / `to_dcp_profile` read those `HsmTable`s directly.

New shape — split the _index_ (always embedded, parsed once) from the _pool_ (lazy, behind a byte-provider):

### 2a. Index stays embedded and eager

```rust
pub(crate) const PROFILES_IDX: &[u8] = include_bytes!("../profiles/profiles.idx");

// Parsed once. Records carry matrices + illuminants + BE-offset + the two
// optional pool indices, NOT the HSM tables themselves.
struct IndexRecord {
    illum1: Option<CoreIlluminant>,
    illum2: Option<CoreIlluminant>,
    cm1: Option<Matrix3>, cm2: Option<Matrix3>,
    fm1: Option<Matrix3>, fm2: Option<Matrix3>,
    hsm1_pool_index: Option<u32>,
    hsm2_pool_index: Option<u32>,
    baseline_exposure_offset: f32,
}

struct PoolDirEntry { offset: u32, compressed_len: u32, dims: [u32; 3], encoding: HsmEncoding }

static PROFILE_INDEX: OnceLock<ProfileIndex> = OnceLock::new();
// ProfileIndex { records: HashMap<CameraKey, IndexRecord>, pool_dir: Vec<PoolDirEntry> }
```

The graceful-degradation contract is unchanged: a bad/missing `profiles.idx` → empty index → `lookup_profile` returns `None` → `dcp::profile_for_with_source` falls through to embedded-DNG matrices or the synthetic path, exactly as today.

### 2b. Pool access goes through a platform byte-provider

```rust
/// Supplies the raw zlib bytes of one HSM pool entry. Native: a slice into the
/// embedded/mmapped pool. Web: bytes that were pre-fetched into a resident
/// store at open-time (see §3). MUST be synchronous — see the note below.
pub trait HsmPoolProvider {
    /// Return the compressed zlib bytes for pool entry `index`, or None if not
    /// resident / fetch failed. The loader inflates + builds the HsmTable.
    fn entry_bytes(&self, index: u32, dir: &PoolDirEntry) -> Option<&[u8]>;
}
```

- **Native provider:** holds the embedded (or mmapped) `profiles.pool` slice; `entry_bytes` returns `&pool[offset .. offset+compressed_len]`. Always resident, never fails for a valid index.
- **Web provider:** holds a handle to the resident-bytes store populated by the async pre-fetch (§3). `entry_bytes` is a synchronous lookup into already-fetched bytes; returns `None` when an entry wasn't pre-fetched (degrade to matrices-only — see §C below).

### 2c. The synchronous-`render_bytes` constraint (critical)

`raw-wasm`'s `render_bytes(raw, ext, xmp) -> Result<MapleRender, JsError>` is **synchronous** (confirmed in `src/raw-pipeline/raw-wasm/src/lib.rs`). The byte-provider therefore **cannot await inside render**. The provider is two-phase:

1. **Async pre-fetch, at open-time, in the worker (cold-open budget — allowed).** Decode just enough of the RAW to compute `camera_key_for(raw)`, resolve the index record (synchronous, embedded), read the ≤2 pool-dir entries, and `await` the range fetch + IndexedDB cache so those entries become **resident**. (We already pay a cold-open decode here; this rides alongside it.)
2. **Synchronous read, during render.** `render_bytes` → `to_dcp_profile` → provider `entry_bytes` is a pure in-memory lookup into the resident store, inflate, build `HsmTable`. No `await`, no WASM-boundary round-trip, no allocation in the slider loop. **This is how HSM stays off the slider-tick path** — render never awaits, and the only per-render work is a small inflate of a ≤32 KB table that is itself cached on the resolved `MapleProfile` for the session (decoded-image cache scope).

To make this concrete in the API surface, `raw-wasm` gains a pre-fetch entry point used by the worker before `render_bytes`:

```rust
// Async (returns a JS Promise). Resolves the body, fetches+caches its pool
// entries via a JS callback, marks them resident. Called once at open-time.
#[wasm_bindgen]
pub async fn prefetch_profile_hsm(raw: &[u8], ext: &str) -> Result<(), JsError>;
```

The JS side passes a fetch+cache callback (range GET → IndexedDB) into the WASM module at init. After `prefetch_profile_hsm` resolves, `render_bytes` runs synchronously as today.

### 2d. `lookup_profile` / `to_dcp_profile` changes

- `lookup_profile(raw)` resolves an `IndexRecord` (matrices + pool indices) instead of a fully-materialized `MapleProfile`. Signature can stay returning a `MapleProfile`-shaped value if HSM is filled lazily; cleanest is an internal `ResolvedProfile { record, provider }` that `to_dcp_profile` consumes.
- `to_dcp_profile(profile, raw)` is unchanged in algebra. The only change: where it reads `profile.hsm1` / `profile.hsm2`, it instead resolves the HSM via the provider:
  ```rust
  let hsm1 = record.hsm1_pool_index
      .and_then(|i| provider.entry_bytes(i, &pool_dir[i as usize])
          .and_then(|bytes| inflate_hsm(bytes, &pool_dir[i as usize])));
  // …then identical .or_else(|| raw.hsm_data.get(&illum)) source-DNG fallback as today.
  ```
  The existing source-DNG HSM fallback (`raw.hsm_data`) is preserved verbatim — it covers bodies the bundle has no HSM for. The dual-illuminant `interpolated_profile` / `single_illuminant_profile` calls and the resulting `DcpProfile` / `ProfileCurve` are byte-for-byte the same as today given the same `HsmTable` inputs.

Net: `MapleProfile`, `DcpProfile`, `ProfileCurve`, and the DCP resolution math are untouched. Only _where the HSM bytes come from_ changes.

---

## 3. Web delivery

**Assets.** `profiles.idx` and `profiles.pool` ship as static assets (under the WASM pkg / `assets/`). The `.idx` is also embedded in the `.wasm` via `include_bytes!` (it's tiny), so the index is available the instant the module initializes — no fetch needed for matrices+index. Only `profiles.pool` is fetched, and only by byte range.

**Range fetch.** The web pre-fetch (§2c) issues an HTTP **range GET** against `profiles.pool`: `Range: bytes=<offset>-<offset+compressed_len-1>` for each of the body's ≤2 entries (coalesce the two into one range when adjacent). Static hosting (the Bun API serving the Angular bundle; any CDN) supports range requests on static files. If a host returns `200` (full body) instead of `206`, the client slices the returned buffer at the known offsets — correctness holds, only the first fetch is larger; subsequent bodies hit the IndexedDB cache.

**IndexedDB cache.** New object store keyed by **pool entry index + asset content version**, e.g. `hsm-pool/<poolVersion>/<index>` storing the inflated-or-compressed entry bytes. Keying on a `poolVersion` (a short hash committed alongside the asset, or the asset's build id) means a regenerated bundle invalidates cleanly — stale entries are never served (same discipline as the rendered-preview cache key in `docs/caching.md`). This is the web analogue of cache layer #5 (remote-source-bytes) but scoped to profile data, and it is **shared across all images of the same body** — open a second Leica M10 and its HSM is already resident.

**Service worker / ngsw.** `profiles.idx` joins the `raw-wasm` asset group (`installMode: lazy, updateMode: prefetch`) so it's cached with the module. **`profiles.pool` must NOT be added to an `assetGroup`** — ngsw asset groups cache whole files, which would re-introduce the 24 MB prefetch. Instead the pool is fetched directly (range GET) and cached in our own IndexedDB store, bypassing the SW for ranges (ngsw passes through requests it doesn't match). Document this explicitly in `ngsw-config.json` review notes so nobody "helpfully" adds `profiles.pool` to an asset group later.

**Latency budget (against the perf invariants).**

- _Slider tick (16 ms target / 50 ms hard):_ **zero** profile I/O. HSM bytes are resident (pre-fetched at open) and the resolved `HsmTable` is cached on the session profile. Unaffected.
- _Cold open (uncached, 250–1000 ms, progress shown):_ adds one (coalesced) range GET of ≤~64 KB compressed + one small inflate, overlapped with the RAW decode that already runs here. Well inside budget; show it under existing cold-open progress.
- _Cold open (warm / repeat body):_ IndexedDB hit, sub-millisecond; no network.

**Failure degrades, never blocks (§C).** 404 / offline / range-unsupported-and-too-large / IndexedDB miss → the pre-fetch resolves with the entry not resident → `entry_bytes` returns `None` → HSM resolves to `None` → **matrices-only render**, identical to today's empty-bundle degradation. HSM is an enhancement; its absence never blocks or errors a render.

---

## 4. Native delivery (Apple FFI, API dylib)

No behavior or parity change. `profiles.idx` and `profiles.pool` are both embedded via `include_bytes!` (or, preferred for memory, the pool is shipped as a sidecar resource and **mmapped** so the OS pages in only touched entries — cutting both startup memory and resident set). The native `HsmPoolProvider` returns `&pool[offset..offset+compressed_len]` directly; inflate-on-demand per entry, cached on the session profile. There is no pre-fetch phase (the bytes are always resident); the two-phase provider collapses to "sync read." Native renders produce identical pixels to today because the resolved `HsmTable` for any body is byte-identical to the inline-v1/v2 table.

mmap note: gate behind the platform (`std::fs` + `memmap2` is fine for the API dylib; the Apple xcframework can mmap the bundled resource or just embed — embedding 24 MB in the static lib is acceptable, it's already how v1 ships, just larger). Decision deferred to implementation; both satisfy parity. Default to embed-via-`include_bytes!` for simplicity unless the xcframework size becomes a problem.

---

## 5. Parity gate

Parity holds **by construction**: every provider resolves the same `(dims, encoding, f32 data)` for a given pool index, so the `HsmTable` handed to `to_dcp_profile` is byte-identical regardless of delivery. The gate must nonetheless _prove_ it runs both providers:

1. **Provider-equivalence unit test (new, in `raw-core`):** for a known HSM body (e.g. Leica M10 — the #378/#379 headline), assert the embedded-provider `HsmTable` and a simulated-fetch-provider `HsmTable` (fed the same `profiles.pool` bytes through the range-slice path) are byte-identical. Cheap, deterministic, runs in CI without fixtures.
2. **`test_color_pipeline.sh` green on native** — the canonical end-to-end perceptual gate. Because #828 lands HSM-disabled (Sequencing), this proves _no regression_ vs the matrices-only path, not an HSM improvement.
3. **Web ↔ native parity** stays the existing merge gate (`docs/testing.md`): identical resolved profile data → identical `maple-cli` / WASM output. No new budget entries; budgets unchanged (one-way ratchet, and #828 changes no pixels while HSM is disabled).

No screenshot evidence; ΔE2000 / byte-identity only.

---

## 6. Migration & sequencing

```
#829 (foundation)  → land the v3 split encoding (NOT whole-stream v2):
                     converter --split writer, pool offset directory,
                     per-entry zlib, dual/tri-version parser, byte-identical
                     round-trip tests, COVERAGE.md, asset-size print.
                     Ships profiles.idx (matrices-only class) + profiles.pool,
                     but profiles.idx still references NO pool entries
                     (HSM bit clear) → HSM disabled, no behavior change,
                     no web bloat. Gates: cargo test green, test_color_pipeline
                     green, no budget change.

#828 (this spec)   → loader refactor: PROFILES_IDX embedded index +
                     HsmPoolProvider (native slice / web prefetch-then-sync),
                     raw-wasm prefetch_profile_hsm entry point, web range-fetch
                     + IndexedDB cache + ngsw notes. HSM STILL DISABLED in the
                     live render path (idx references no pool entries yet);
                     the provider is proven by the §5 equivalence test + a
                     diagnostic that exercises a fetch, NOT by the live pipeline.
                     Verification = tests, not live render. Gates: provider
                     equivalence test, test_color_pipeline green (no regression),
                     no WASM size regression (measure .wasm before/after).

#825 (flips it on) → enable HSM: emit profiles.idx WITH pool references for the
                     ~1,080 HSM bodies, fix valScale/dual-illuminant apply math
                     + tier ordering, re-evaluate budgets, ratchet down.
                     This is the first point the live render fetches a body's
                     HSM entries — and the point the ticket's "fetches only its
                     body's entries" acceptance becomes observable end-to-end.
```

**Why #828 lands HSM-disabled:** the moment the index references pool entries, the live render path depends on #825's apply-math fixes (which currently regress 3 of 8 HSM bodies — see #825). Landing #828's _delivery mechanism_ decoupled from #825's _application correctness_ keeps each PR independently parity-clean. The provider is fully exercised by the equivalence test and a diagnostic example (`probe-profile-source`-style) that resolves + fetches a body's HSM and prints it — so #828 is genuinely done and verified, not a stub, even though the live pipeline doesn't consume HSM until #825.

**Non-goal restated:** this spec does not touch HSM application math. It guarantees HSM is _resolvable_ (correct bytes, lazily, cached, parity-safe) and hands the resolved `HsmTable` to the unchanged `to_dcp_profile` algebra.

---

## Open items handed to implementation

- **Asset-size validation (#829):** confirm per-entry zlib total stays ~24–25 MB. If it overshoots ~25 MB materially, group small entries into range-aligned chunks (directory then maps index → (chunk, intra-chunk offset)).
- **Native pool delivery:** embed-via-`include_bytes!` vs mmapped sidecar — both parity-safe; default to embed unless xcframework size forces mmap.
- **`poolVersion` cache key:** short content hash committed beside the asset, or reuse the build id; must invalidate on bundle regen.
- **Range-not-supported host fallback:** confirm the Bun API static handler emits `206` for `Range` on `profiles.pool`; if not, the `200`-and-slice fallback (§3) is the safety net.
