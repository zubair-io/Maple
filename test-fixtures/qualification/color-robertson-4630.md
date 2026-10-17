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
Native-host WASM tests do not claim browser-WebGPU execution.

## Remaining integration qualification

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

An early read-only comparison of the first three completed fixtures covers
33 neutral baseline/WB cases. All 33 candidate PNG pixel arrays are exactly
equal to main. This is a partial diagnostic, not the completed 220-comparison
qualification; final whole-input audits remain pending with both runners.

Evidence, commands, frozen SDK source, source identities and the selected
manifest are preserved under
`/Volumes/Projects/maple-color-gate-20261015/robertson-current-main/`.
