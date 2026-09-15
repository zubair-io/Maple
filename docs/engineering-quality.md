# Engineering quality assessment

Audit snapshot: `1f233acb91dd97c2103a6903279be4dee5329192` from `origin/main`,
2026-09-15. Tracking: [KTLO audit #3640](https://github.com/zubair-io/Maple/issues/3640).
The [engineering map](engineering-map.md) describes responsibilities and scale.

## Overall assessment

Maple has strong shared foundations and uneven enforcement around them.
The common Rust engine, generated contracts, separate Apple UI package,
large common Angular library and specialized parity harnesses are real
architecture, not merely intended architecture.

The main maintenance problem is **ownership that remains distributed after
file-level or UI-level unification**. Examples include independently maintained
ID rules, stage registrations, metadata conversions, and window/session types
spread across many files. Existing tests protect several copies; other copies
have already diverged. The API's non-passing, non-gated typecheck is the clearest
immediate engineering-control gap.

This is a repository-wide structural inventory plus targeted source review and
selected executable checks. It is not a line-by-line review of roughly a million
physical source lines, a security certification, or a new performance qualification.
All major deploy units are mapped. Runtime quality of every subsystem remains
unproven by this audit; those limits are explicit below.

## Assessment by area

| Area                   | Judgment from reviewed evidence                                                                     | Confidence and limit                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Rust core/GPU          | Strong central ownership; intentional independent reference/parity design                           | Medium: manifests, module boundaries and selected duplicates reviewed; no fresh numerical/performance runs |
| Apple domain/rendering | Clear actor/lifecycle patterns, but large orchestration types and historical size exceptions        | Medium: selected coordination code reviewed; not all async races exercised                                 |
| Apple UI               | Strong package boundary and substantial reusable component surface                                  | High for dependency boundary; visual/accessibility behavior not requalified                                |
| Web                    | Sharing is already extensive; remaining repeated field mappings, application glue and adoption gaps | Medium: whole-project static scan plus targeted review; no complete browser execution                      |
| API                    | Highest concentration of actionable engineering debt in this audit                                  | High for typecheck failure, repeated helpers and database cycle; not a claim all API behavior is poor      |
| Windows                | Real WinUI/services/UI investment; central window still highly coupled, build wrapper misleading    | Medium: C# source and build configuration reviewed; no Windows host execution                              |
| Public image package   | Useful shared engine consumer with explicit execution modes; queue admission is unbounded           | High for source property, unmeasured for resulting memory/throughput impact                                |
| Edge workers           | Small deploy units with focused responsibilities; copied contracts cross deployment boundaries      | Medium: routing/key/config review; no worker-isolate execution or security certification                   |
| CI and tooling         | Many meaningful gates; passing status does not imply full codebase or device coverage               | High for reviewed workflow definitions and executed inventory checks                                       |

## Confirmed findings

Priority labels describe suggested KTLO order, not incident severity. No critical
production incident was established by this investigation.

### Q1 — High: the API strict typecheck is failing and is not a CI gate

`src/api/package.json` advertises `typecheck: tsc --noEmit`; its tsconfig enables
strict checking over both source and tests. On the pinned revision with frozen
dependencies, it reports **137 diagnostics in 80 files**, including **23 in 18
non-test files**. `.github/workflows/api.yml` executes Bun tests but does not run
this command.

Examples: stale `./channel.ts` type import in `src/api/src/indexer/indexer.repo.ts`,
MongoDB identifier types in configuration repositories, and stale auth payloads
in tests. A successful runtime test run cannot establish that these types agree.
The missing import is in apparently retired repository code, so it is not evidence
that the live server fails at startup.

Evidence: [full diagnostics](engineering-audit/api-typecheck.txt).
Remediation: [#3641](https://github.com/zubair-io/Maple/issues/3641).

### Q2 — Medium: duplicated ID parsers have already diverged

`src/api/src/indexer/id.ts::fromHex` checks each pair with `parseInt` and accepts
partially valid hexadecimal. The web copy at
`src/web/projects/maple-common/src/lib/addressing/maple-id.ts::fromHex` has a
whole-string regex and rejects the same input.

Executed input: `'01' + '0g'.repeat(15)`; [captured result](engineering-audit/id-parity.json).

- API: accepts; returned `hex` contains `g`, while returned bytes encode
  `01000000000000000000000000000000`.
- Web: throws `maple:id: invalid hex digit`.

No production caller of the API parser was found. The observed problem is a
broken duplicated contract and retained unused surface, not an exposed API exploit.
The web's valid-ID golden cases do not ensure the API copy receives later fixes.
Remediation: [#3642](https://github.com/zubair-io/Maple/issues/3642).

### Q3 — Medium: stage registration is repeated across runtime layers

Twelve stage names are listed in `workers/stages/stage-names.ts`, stage objects in
`workers/stages/manifest.ts`, and starter tuples in `workers/orchestrator.ts`.
The first list must remain dependency-light because database initialization uses it.
The current API lists agree; no missing running stage was reproduced.

The web's `settings/workers/workers.vm.ts::STAGE_META` independently classifies
stages and has no explicit `sidecar-metadata-index` or `cf-thumb-sync` entry.
Those stages receive the generic fallback. The code's #3491 history documents
how earlier list duplication caused missing indexes; that history is supporting
context, not a claim the same performance bug remains.

Remediation: [#3643](https://github.com/zubair-io/Maple/issues/3643).

### Q4 — Medium: existing shared helpers are bypassed

`src/api/src/routes/backup-sidecar.ts` maintains its own `atomicMove` despite the
equivalent implementation and same mirrored filesystem dependency in
`src/api/src/backup/fs-util.ts`.

`backup/location-segments.ts` and `routes/library-relocate-helper.ts` separately
encode civic-prefix removal, US state/country selection and the New York City
rename. Their adapters differ intentionally: one reads geocoded Place data with
a POI fallback, the other reads user metadata overrides. Common policy is duplicated;
the entire functions should not be treated as interchangeable.

Remediation: [#3644](https://github.com/zubair-io/Maple/issues/3644).

### Q5 — Medium: database bootstrap imports a repository that imports bootstrap

Confirmed import/re-export chain:

`src/api/src/db/client.ts` → `db/migrations.ts` →
`people/people-face-count.repo.ts` → `db/client.ts`.

The backfill already accepts a `Db`, but shares its module with functions using
global collection accessors. This creates unnecessary initialization coupling.
No initialization crash was reproduced. Fallow also reports a face-detector/pool
cycle; its lazy import makes it a different case requiring separate judgment.

Remediation: [#3645](https://github.com/zubair-io/Maple/issues/3645).

### Q6 — Medium: local Windows build success does not prove the requested build

`src/windows/scripts/build-windows.sh` reads/prints `WINDOWS_TARGET`, but neither
Cargo invocation passes it as a target. It conditionally skips the WinUI build
when `dotnet` is missing and still prints success. The csproj's native copy path
also assumes `target/release`, so adding a target flag alone is insufficient.

This was established by source inspection, not by running Windows tooling.
Remediation: [#3646](https://github.com/zubair-io/Maple/issues/3646).

### Q7 — Medium: worker concurrency is bounded, pending memory is not

`src/maple/src/worker-pool.ts::NativeWorkerPool` bounds worker count but appends
requests to an unbounded array and pending-promise map. Queued request arguments
remain retained; image buffers can be large. This establishes a resource-control
gap when callers submit work faster than it completes. It does not quantify a
current memory regression or show that any existing caller saturates the queue.

The API's child-process pool serves a different crash-isolation purpose; replacing
it with this pool would not be a valid DRY improvement.
Remediation: [#3647](https://github.com/zubair-io/Maple/issues/3647).

### Q8 — Medium: test inventory completeness is much wider than test execution

The Swift regression coverage checker passes with **412 MapleCore classes**:
**35 selected, 377 excluded**. Exclusion categories are fixture 40, GPU 13,
host 94, slow 50, and **untriaged 180**. These categories are not proof that tests
cannot run. They are also not coverage percentages: class sizes and assertions differ.

Meanwhile `docs/architecture.md`, `docs/performance.md` and `CONTRIBUTING.md` still
describe Apple CI as compile-only/no tests. `apple.yml` contains a real
`swift-regressions` execution job using a release native archive. The current
documentation understates executed tests while the green inventory checker can
overstate the extent of qualification if read without its exclusions.

Remediation: [#3648](https://github.com/zubair-io/Maple/issues/3648).

## Structural debt and protected duplication

These are verified structures, not independently reproduced behavioral failures.

| Observation                              | Evidence                                                                                                                                                 | Interpretation                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| File splits leave large shared types     | Windows `MainWindow*.cs`: 29 files / 5,932 lines; Apple `EditSession*.swift`: 28 / 4,800; `RenderActor*.swift`: 9 / 1,620                                | File-size compliance is not responsibility isolation; not every extension merits a new abstraction              |
| Historical size exceptions remain        | Gate reports 23 allowlisted paths; e.g. `raw-core/src/color/dcp.rs` 3,189 lines, `FileProviderExtensionCore.swift` 2,607, `PipelineRenderer.swift` 2,006 | Existing split tickets are recorded in `tools/budget-allowlist.txt`; raw size alone does not establish a defect |
| Adjustment tables copied into API        | `src/api/src/presets/adjustment-fields.ts`; golden test imports generated web ranges                                                                     | Four tests / 135 assertions pass: duplication is protected, but adds manual edit burden                         |
| Color labels copied across platforms     | API `xmp/color-label.ts`, web `models/color-label.ts`, Windows `Services/Xmp/XmpSidecarDocument.cs`                                                      | API/web comments explicitly ask for manual synchronization; codegen already emits other API DTOs                |
| Blue-noise data repeated in CPU/GPU code | `raw-core/src/view/dither.rs`, `raw-gpu/src/dither.rs`; `inlined_blue_noise_matches_raw_core`                                                            | Intentional checked duplication; not reported as uncontrolled drift                                             |
| C# ABI mirrors are manual                | `Maple.WinUI/Native/MapleAdjustmentParams.cs`, `MapleGpuLiveParams.cs`; Windows CI layout tests                                                          | More maintenance than generation, but an existing safety gate must be credited                                  |
| Edge object key is copied                | API `cloudflare/thumb-key.ts`, Worker `src/r2.ts`                                                                                                        | Deploy independence does not remove contract dependence; current algorithms match                               |
| Inert alternative Windows shell remains  | `tauri.conf.json`, optional `tauri-build`; `docs/windows.md`                                                                                             | Documented residue, not the active product architecture                                                         |
| Public package absent from overview map  | `src/maple/package.json`, workspace `raw-napi` member versus older overview                                                                              | The new engineering map includes both consumers and execution models                                            |

## UI adoption: what the passing check means

The web adoption check passes **17 migrated directory/file entries**, checking raw
buttons and two legacy CSS classes. It does not check every template or certify
interaction/accessibility parity. A separate source search, excluding `lib/ui`
and the UI gallery, finds **98 raw `<button>` tags in 44 templates**. These are
candidates, not 98 violations: menus, specialized canvas controls and intentional
exceptions need semantic review. Example concentrations are editor-shell,
batch-metadata, timeline-filter-row and inline-rename-field.

Apple MapleUI's dependency-free package is an enforced boundary. Windows MapleUI
lives inside the app project, so reuse exists at the code/namespace level without
the same independently enforced package boundary. The audit does not infer that
every platform should have identical package structure.

## Whole-project static scan

Fallow 2.103.0 ran against both installed, frozen-lockfile projects without
changed-file filtering. Existing project suppressions still apply.

| Output                                 | Web | API |
| -------------------------------------- | --: | --: |
| Dependency/unused/interface candidates |  99 | 113 |
| Duplicate groups                       |  24 |  85 |
| Complexity findings                    |  14 | 100 |
| Reported import cycles                 |   0 |   2 |

[Candidate records](engineering-audit/scan-candidates.json) preserve file/symbol
locations. Counts are tool output, not defect counts. Coverage/CRAP fields in that
file use the tool's estimates, not measured execution coverage. Fallow's suggested
fix actions were intentionally omitted from the artifact to avoid presenting
automatic deletions or suppressions as endorsed remediation.

Selected complexity hotspots: `buildBatchApplyMetadata` (web, cyclomatic 52),
`buildFilter` (API search, 67), `listDirContents` (61), `ensureIndexes` (60).
Repeated metadata field conversions are a more concrete consolidation target
than a generic demand to make every score smaller.

The existing CI Fallow jobs scope to changes versus the base branch; a passing
PR gate does not assert that these whole-project findings are absent.

## Verification and coverage limits

[Machine-readable results](engineering-audit/verification.json) record commands.

| Executed check                     | Result                                                          |
| ---------------------------------- | --------------------------------------------------------------- |
| File budget                        | Pass: 0 hard violations, 485 soft warnings, 23 allowlisted      |
| Maple UI contracts                 | Pass: 28 contracts                                              |
| Web adoption ratchet               | Pass: 17 migrated scopes                                        |
| Editor parity manifest             | Pass: 63 capabilities, 31 web tools, 33 Apple tools, 102 ranges |
| Swift regression classification    | Pass, with execution exclusions described above                 |
| Selected API contract/helper tests | 36 pass, 0 fail, 175 assertions                                 |
| API typecheck                      | Fails as described in Q1                                        |
| ID parser comparison               | Reproduces API/web disagreement                                 |
| Whole-project Fallow               | Candidates recorded, selectively verified                       |

No fresh CPU/GPU numerical parity, physical-device performance, full app test
suite, Windows execution, Cloudflare isolate tests, or vulnerability/license
review was performed. Hardware/fixture-dependent quality remains **unmeasured
in this audit**, rather than implicitly passing. Existing perf rows explicitly
exclude scanout/gesture latency and include contention caveats. The Metal job in
`raw-pipeline.yml` is marked `continue-on-error`; Linux software-GPU parity is a
different gate and does not certify every hardware backend.

## Using this record across sessions

The fixed revision, complete source inventory, preserved candidates, executable
check results and linked issues are the durable record. A later session can
select an issue, inspect its exact evidence and compare changed paths since this
revision. Findings on changed code require revalidation; unchanged findings need
not be rediscovered. Work status belongs to GitHub issues, while these documents
remain a descriptive record of the audited revision.
