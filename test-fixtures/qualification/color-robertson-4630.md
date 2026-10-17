# Robertson inverse tint correction — #4630

## Saved implementation checkpoint

The inverse temperature/tint conversion measured tint displacement from the
upper bracketing Robertson table row instead of the interpolated locus point.
The isolated correction updates Rust, Swift and TypeScript while retaining the
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

## Remaining integration qualification

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

### Version and complete-cohort integration

This commit preserves the implementation under #4630 before opening a ready
PR. It does not yet bump derived-output versions, claim a passing physical
cohort, or authorize merging this checkpoint. After integrating the current
main, complete version invalidation, generated evidence, hardware/binding
parity and the affected physical comparison before opening the PR.

The physical selection is prepared: 20 neutral baselines, the same 20 Auto
baselines, and all 180 canonical temperature/tint and WB cases, for **220
comparisons**. It uses the same frozen native-pair comparator and numerical
budgets as the ongoing main run. Main's verified outputs will supply controls;
no full main run is restarted. No physical failure is claimed as cleared yet.

All **220 candidate PNG files** now have SHA-256 hashes identical to the
corresponding frozen main outputs, proving identical pixels and metadata
across the entire selected cohort. Each file's size and modification time
remained stable during the audit. The frozen main renderer's source tree is
also identical to current main `676c40a7db1121179b5fe08dd2332e7da8a1834a`.
The per-file hashes and replay command are retained in
`physical/current-main-png-identity.json` and
`compare-robertson-main-outputs.py` in the evidence directory. This supersedes
the earlier 33-case diagnostic. Budget comparisons and final whole-input
audits remain pending with both runners; this does not claim a passing
whole-corpus gate or any canonical failure cleared.

Evidence, commands, frozen SDK source, source identities and the selected
manifest are preserved under
`/Volumes/Projects/maple-color-gate-20261015/robertson-current-main/`.
