# Robertson inverse tint correction — #4630

## Isolated inverse-tint repair

The inverse temperature/tint conversion measured tint displacement from the
upper bracketing Robertson table row instead of the interpolated locus point.
The isolated correction updates Rust, Swift, TypeScript and C# while retaining the
table, tint scale, forward mapping and sidecar schema. Legacy conversion ports
also retain the authoritative Rust f32 arithmetic; updated cross-language
goldens keep their original tolerances.

On main `d0689ff4cea06b320910cc703a90fd8241c24808`, the independent SDK input
`xy = [0.3135279119, 0.3235340714]` returns tint `+0.74360937`. The corrected
source returns `-0.0000077107`, matching the SDK's near-zero result.

All 18 regression vectors were independently reproduced by compiling a fresh
copy of Adobe's DNG SDK source from Android's source mirror. Its SHA-256 is
`39797f582384204dbe82bf37d17acc52073cc8db1da710d1f954fe7b37d16dc4`.
The vectors avoid a separate table-row discrepancy; this correction preserves
Maple's existing table and addresses the interpolation origin only.

## Algorithm qualification on this checkpoint

| Check | Passed | Ignored |
| --- | ---: | ---: |
| Rust temperature mapping, including 18 SDK vectors | 9 | 0 |
| Canonical debug core suite with GPU/test-support features | 2,806 | 100 |
| TypeScript mapping, legacy/partial WB and presets | 143 | 0 |
| Isolated Swift package with exact production mapping source | 5 | 0 |
| Metal GPU library parity suite | 287 | 4 |
| FFI library with GPU bindings | 301 | 6 |
| Native-host WASM library with GPU bindings | 74 | 7 |

No source changed during qualification. The Swift run is a pure mapping test,
not a full MapleCore or Apple renderer qualification. Existing CI executes both
`WbDngTemperatureTests` and `WbScaleVersionTests`.

An initial full-library invocation used release mode: 2,803 tests passed and
three tests that expect debug color-space assertions failed because release
builds disable those assertions. The documented debug invocation above passes
all three without changing their assertions. Both logs are preserved.

The GPU and binding runs use the same committed algorithm revision
`afdc8ffb4f429c1899f27882244f5f6b8104d739`; source hashes remain unchanged.
That revision is retained as `codex/qualification-robertson-afdc8ffb` for
reproduction after the working branch is rebased.
Native-host WASM tests do not claim browser-WebGPU execution.

## Windows review correction

Review of PR #4804 identified the remaining Windows legacy-sidecar reader.
It now measures inverse tint from the interpolated locus and evaluates the
legacy forward map with the same f32 arithmetic as raw-core. The existing
V2/V3/V4 parser expectations are corrected, and all 24 shared-core legacy
vectors are checked at the unchanged 0.05 K / 0.005 tint tolerances.

The cross-platform .NET XMP suite passes **223 tests in both Debug and Release,
zero failures/skips**,
including the 37 version/mapping tests and legacy save/reload coverage. This
runs the actual production C# parser, serializer and mapping sources on the
macOS .NET host; Windows application execution remains a CI gate. The initial
run retained one stale temperature-only tint expectation, which was corrected
from 11.083624 to 9.9615898; its failure log is preserved with the passing run.

Rust and other mapping sources are unchanged by this review correction, so
the physical renderer qualification below remains applicable. Logs and TRX
results are archived under `robertson-current-main/windows-review/` and
`robertson-current-main/windows-xmp-review.log`.

## Derivation provenance and documentation review

The corrected inverse also changes newly derived Auto and sampled white-balance
pairs. Both estimator provenance constants advance from 2 to 3; generated
Swift, TypeScript and C# Auto-WB constants are regenerated from raw-core.
Existing sidecars retain their stored pair and provenance. Pipeline output
remains 26, with thumb/preview target 30, and the hand-maintained cache/version
documentation now describes those values. Fresh provenance/domain validation
is recorded separately from the previously completed pixel comparisons.
The mapping, white-balance provenance and Auto-derivation tests pass at
`46dabcc30f6fc02a0259c1886df2eb5ce1d6710e`. All five domain/API suites were
recorded and independently rechecked at that revision: 62 cases pass in each
pass, with zero failures or skips. Generation and its repeat pass without
drift, all monitored sources remain unchanged, and the original RAW hash is
unchanged. The complete record is in `qualification-provenance3/`.

## Physical qualification

### Physical legacy-sidecar control

A temporary V2 sidecar on the original `test_0001.RAW` authors 5700 K / tint
50. The legacy forward mapping yields xy `[0.3281915486, 0.3340478241]`.
The independent Adobe SDK inverse converts that to a V5 pair of
5696.39338761 K / tint -5.0375062965. A second temporary sidecar authors that
SDK pair directly. Both frozen renderers render both inputs through AMaZE
and Neutral with bundled lens matching disabled.

| Renderer | Mean ΔE2000 against its SDK-equivalent V5 render | Maximum ΔE2000 |
| --- | ---: | ---: |
| Main | 0.220400 | 25.684632 |
| Corrected inverse | 0 | 0 |

The corrected legacy render matches all **10,036,224 pixels** exactly.
The V5 forward control itself is pixel-identical across main and candidate,
and all input hashes remain unchanged. The first invocation produced no
renders because the frozen main executable lacked its execute bit; the
successful run used hash-identical executable copies without modifying the
archived binaries. Source, SDK oracle, temporary sidecars, commands and metrics
are preserved in `robertson-current-main/legacy-physical/`.

This verifies a physical legacy import correction. It is not an Adobe-rendered
reference comparison and does not count as a canonical corpus failure cleared.

### Complete affected cohort

The physical selection completed: 20 neutral baselines, the same 20 Auto
baselines, and all 180 canonical temperature/tint and WB cases, for **220
comparisons**. It uses the same frozen native-pair comparator and numerical
budgets as the ongoing main run. The cohort reports **192 passing and 28
failing comparisons**: 28 failures among 200 Neutral cases and zero failures
among 20 Auto baselines. There are no missing cases, errors or skips. All
820 physical input hashes, the frozen binary and comparator sources remain
unchanged. This subset is not a new full-main failure count.

All **220 candidate PNG files** now have SHA-256 hashes identical to the
corresponding frozen main outputs, proving identical pixels and metadata
across the entire selected cohort. Each file's size and modification time
remained stable during the audit. The frozen main renderer's source tree is
also identical to current main `676c40a7db1121179b5fe08dd2332e7da8a1834a`.
The per-file hashes and replay command are retained in
`physical/current-main-png-identity.json` and
`compare-robertson-main-outputs.py` in the evidence directory. This supersedes
the earlier 33-case diagnostic. Identical candidate/control files and the same
references, comparator and budgets establish **zero new failures and zero
canonical failures cleared** in this cohort. The physical comparison and
final whole-input audit are complete; the full-main runner continues.

All **776 canonical sidecars** were also parsed by the frozen main and
candidate CLIs. Their complete `AdjustmentModel` outputs are byte-identical,
and every original sidecar hash is unchanged. The audit is preserved in
`corpus-sidecars/identity.json`; it supplements the physical cohort without
claiming that all 806 comparisons were rerun for this branch.

## Cache and generated-evidence integration

Pipeline output **26** invalidates derived images made with the old legacy
conversion. Auto fit-model version remains **2**: its pinned fitting input
does not depend on an imported legacy temperature/tint pair. The branch is
based on main `1f26feb6d2b312272012e803c53be581a93c464c`. A preceding output
version change on main requires the next version when this branch is rebased.

All five CI-recorded suites were executed and independently rechecked at
version 26: synthetic grey (6), color chart (7), grey adjustments (41), grey
DCP (5), and API sidecar contract (3). All **62 cases pass**, with no failures
or skips in either pass. The nine Rust mapping tests also pass at this
version. Generation and its repeat have no drift; source/reference hashes
and the monitored RAW remain unchanged.

The earlier version-26 records named `bd2f3387d8aa40bd3677f51986fc43c6a82943bd`,
retained on `codex/qualification-robertson-bd2f3387`. Their logs, source identities
and generated evidence remain under `qualification-version26/`. The current
records name `46dabcc30f6fc02a0259c1886df2eb5ce1d6710e`, retained on
`codex/qualification-robertson-46dabcc3`, with evidence under
`qualification-provenance3/` in the same directory.
Prior physical-color evidence keeps its original version and status; the
220-case diagnostic does not promote a full-corpus qualification record.

Evidence, commands, frozen SDK source, source identities and the selected
manifest are preserved under
`/Volumes/Projects/maple-color-gate-20261015/robertson-current-main/`.
