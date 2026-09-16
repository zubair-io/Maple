# Web static-candidate triage

Issue [#3667](https://github.com/zubair-io/Maple/issues/3667), reviewed at
`9e601f937` on 2026-09-16. The machine-readable
[disposition ledger](web-scan-triage.json) covers every Web candidate in
[the original scan](scan-candidates.json) at `1f233acb9` and the equivalent
fresh whole-project scan. This is a triage result, not a dead-code cleanup or
runtime qualification.

## Result

| Disposition                   | Candidates | Meaning                                                                                                                                               |
| ----------------------------- | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed                     |          4 | Redundant export modifiers on live implementation helpers; [#3712](https://github.com/zubair-io/Maple/issues/3712)                                    |
| False positive                |         45 | Concrete template, DI/interface or test consumers; or complexity incorrectly interpreted as a defect                                                  |
| Intentional checked duplicate |         19 | Source blocks inspected together; separate operation/schema/component ownership retained                                                              |
| Already tracked               |          1 | AI provider payload work in [#3635](https://github.com/zubair-io/Maple/issues/3635), pending [PR #3699](https://github.com/zubair-io/Maple/pull/3699) |
| Requiring runtime evidence    |         68 | Explicitly unresolved; not approved for deletion or suppression                                                                                       |
| **Total**                     |    **137** | **99 usage/config findings + 24 clone groups + 14 complexity findings**                                                                               |

The fresh inventory matches the original candidate fields and clone fingerprints
one for one. Complexity ordering can vary; the ledger records both original and
fresh indices. No fresh category added candidates. Each row retains its original
source location, score/coverage fields where present, disposition, rationale and
evidence paths. Unresolved rows name the additional evidence needed.

The confirmed change is deliberately narrow: make `FIT_SNAP_FACTOR`,
`FIT_UNDERSHOOT`, `SLIDER_INTERACTION` and `SLIDER_A11Y` private to their modules.
Repository-wide reference searches found only local implementation uses (plus
zoom documentation), with no importing or public-barrel consumer. Their values,
functions and behavior remain necessary. Other unused-export warnings involving
DI factories, IDB records, fallback storage and worker state remain unresolved
as export-boundary questions, rather than being called dead implementations.

## Entry points and interpretation

The scan reports 638 entry points: 2 manual, 16 package-derived and 620 plugin-derived.
Before interpreting usage findings, the review traced:

- Both `projects/maple/src/main.ts` and `projects/maple-syrup/src/main.ts`
  bootstrap their own `App` and `appConfig`. Duplicate `appConfig` exports do
  not collide across these independent composition roots.
- `angular.json`, app routes, external templates, the `@maple-common` source
  alias in `tsconfig.json`, and `projects/maple-common/src/public-api.ts` define
  distinct compiler, router, template and library entry surfaces.
- `self-hosted-workspace.providers.ts` binds `SERVER_LIBRARY_IO` to
  `BunApiBackendService` and supplies XMP/preview persistence closures;
  `hosted-workspace.providers.ts` binds `LIBRARY_SOURCE` to
  `FsAccessLibrarySource`. Concrete-class reference counts miss interface calls.
- `PeopleBulkController` members are invoked through `bulk()` in
  `people-list.component.html`; the asset grid binds `trackRow` through
  `cdkVirtualFor`. The browse-content test replaces component imports with
  selector-compatible stubs while retaining the real template's bindings.
- `createHostedUserPresetStore()` selects in-memory or IDB implementations
  behind `UserPresetStore`; `PresetsService` calls all three methods.
  `OBSERVABILITY_CONFIG_CACHE` selects its concrete implementation through DI;
  the observability service calls `get` and `put`. The untraced `clear` methods
  are deliberately not granted the same false-positive disposition.
- Angular dispatches `MapleErrorHandler.handleError` through the configured
  `ErrorHandler` provider. Worker construction uses `new Worker(new URL(...,
import.meta.url))`; structural Worker stubs and sampler methods require
  receiver-aware analysis rather than symbol-name matches.
- `.storybook/main.ts` discovers stories by glob. WASM `pkg/raw_wasm` is built
  and copied by `build.sh`/`sync-raw-wasm.sh`; generated TypeScript mirrors come
  from `tools/codegen.sh`. This review did not build missing WASM artifacts.

The twelve unlisted-dependency findings are **unresolved package-boundary
questions**, not missing workspace installations: the root package declares the
packages while `maple-common/package.json` does not. Source-alias applications
and an isolated ng-packagr consumer have different dependency contracts; no
isolated library install/build was performed to settle them.

## Duplication and complexity

Checked clones include separate settings form lifetimes, operation-specific
cleanup, schema-specific IDB stores using existing shared helpers, distinct
worker error protocols, and matching XMP attribute parsing. The People toolbar
SCSS explicitly documents Angular style encapsulation; both declarations were
compared. “Checked” means source inspection, not a newly run visual or behavior
regression test.

Shared timer/save-state skeletons and concurrent registered-folder seeding
remain unresolved: source shape alone cannot establish overlapping-request or
unmount behavior. Those rows state the needed lifecycle/concurrency scenarios.
The forward/inverse temperature transform clone is retained as intentional
mathematical symmetry; no color code was edited or qualified here.

Complexity scores alone are not defects. The inline icon template and explicit
cursor switch have no demonstrated problem; test-fake scores are not production
failures. Metadata mapping, GPU presentation, crop geometry, folder resolution,
pano submission and deep-link handling retain scenario-specific evidence needs.
All `coverage_source: estimated` fields remain unchanged. They are **not measured
execution coverage**, and no coverage percentage is claimed.

## Reproduction and limitations

From the reviewed checkout:

```sh
cd src/web
bun install --frozen-lockfile
./node_modules/.bin/fallow --format json --no-cache > /tmp/web-fallow.json
```

Environment: macOS arm64, Bun `1.4.3-canary.1`, locked Fallow `2.103.0`.
The combined scan returned exit 1 with findings and valid JSON. The separate
`fallow dupes --format json --no-cache` and
`fallow health --format json --no-cache` reports were also inspected.
The ledger records the lockfile SHA-256, fresh summaries and exact configuration.

Existing suppressions remain visible: `_design-reference/**`, generated mirrors,
HTML-only health exclusions, ignored dependency/import patterns, and all 60
inline suppression lines are captured in the ledger. The four stale-suppression
candidates remain explicit; none was removed. The reviewed `.fallowrc.json` and
lockfile were unchanged. The scan is only as broad as that configuration; it
cannot certify ignored/generated files as clean.

Validation checked unique IDs, exhaustive original/fresh inventory mapping,
unchanged original candidate fields, all evidence paths, disposition totals,
JSON parsing and formatting. No application code changed. No Angular tests,
browser sessions, image/performance harnesses, generated-artifact rebuilds or
independent package-consumer tests were run. The 68 unresolved candidates remain
visible in this reference ledger; closing the triage issue does not resolve them.
