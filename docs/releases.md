# Stable releases and the next development version

`main` carries the version currently being tested. Every push to `main`
continues to start TestFlight; no TestFlight trigger is disabled by this flow.

## Create a release

Run **Actions → version-sync → Run workflow** on **main**. Leave `next_version`
empty for a patch increment, or supply a higher stable `X.Y.Z` version. Leave
`advance_only` false for a normal release.

For example, when main contains `0.1.3`:

1. Validate that the committed package, source, distribution, and Apple versions
   all say `0.1.3`, and that main's CI is successful.
2. Create/reuse the KTLO issue, then prepare `release/next-v0.1.3` with only the version changes for `0.1.4`.
   This branch is also the durable handoff marker. It does not change main.
3. Refresh `release-handoff-complete` on **all** open PR heads to hold merges.
   Verify main has not moved.
4. Create annotated tag `v0.1.3` on that exact main commit. The existing release,
   npm, and Xcode Cloud production workflows consume the tag independently.
5. Open a ready next-version PR, linked to an issue on KTLO. Only this exact
   version-only commit passes the handoff gate (statuses are per commit, so
   another PR with the identical commit receives the same status); it must also pass Release
   readiness, which waits for the complete release PR CI suite.
6. Review and **rebase-merge** that PR. Main now contains `0.1.4`, TestFlight
   builds that version, and other PRs are unblocked. This merge creates no tag.

The source release is a tag, not a second mutable release branch. The
`release/next-v…` branch is for the next development cycle, not store builds.
There is intentionally no automatic merge of the bump PR.

## One-time rollout

The workflow and controller must land on main before requiring their status.
Keep the existing **Main** ruleset, strict up-to-date setting, rebase-only rule,
and `Release readiness` check. Add **release-handoff-complete** as another
required status check, issued by GitHub Actions. Do not replace existing rules.

First run **release-handoff** manually to seed statuses on open PR heads, then
add the requirement. The release dispatcher refuses to create a release if
this requirement is absent. A PAT/GitHub App credential in `VERSION_SYNC_TOKEN`
(fallback: existing `JULES_GH`) needs contents, PRs, issues and statuses write,
Actions/rules read, and access to the KTLO project. The credential must trigger
downstream workflows; the ordinary `GITHUB_TOKEN` is not used for release pushes.

At rollout, main still says `0.1.2` and `v0.1.2` already exists on an older
commit. Run **version-sync** with **advance_only = true** once. This explicitly
opens the `0.1.3` migration PR without releasing anything or moving `v0.1.2`.
Merge it after CI. Normal releases can then use the default mode. Activating
the gate before this migration deliberately holds all other PRs until it lands.

## Failure and retry behavior

Re-run a failed version-sync run to reuse its original release commit, existing
branch, tag and open PR. A rerun after handoff completion is a no-op; it never
releases the next version. A **new dispatch** after the bump is merged means a
**new release**, not a retry of the previous one. Each dispatch is pinned to its
original main SHA and refuses to silently select newer main commits.

- A tag on another commit is never moved or overwritten. Use advance-only only
  for an already-released version whose tag is in main's history.
- After a successful status refresh, a failure creating the tag or PR leaves
  other merges blocked. Fix the credential/build/PR failure and retry. Reopen a closed unmerged bump
  PR before retrying; do not merge unrelated changes to get around the gate.
- If main moved during setup before tagging, inspect the new main CI and start
  a **new dispatch** on main. It regenerates the version-only handoff branch
  with an explicit force-with-lease. If main raced the final check and the tag
  was already published, dispatch with **advance_only = true** to repair the
  bump branch on new main without moving the tag. Changes merged after the
  pinned tag are not part of that release. The gate rejects added source edits,
  mode changes, different PR heads, and stale parents.
- A cancelled status refresh can be recovered with **release-handoff → Run
  workflow**. Every refresh reads current main and updates every open PR, so
  coalesced events do not leave only the event's PR updated.

This is an asynchronous merge guard, not an atomic branch lock. An already
in-flight merge can race the first status refresh; the final main-SHA check
detects movement up to that check. A failed status API call may leave some
old green statuses intact, but aborts setup before publishing a new tag. Retry
the refresh after the API recovers. Avoid starting a release while merging
other PRs. No workflow dynamically locks or relaxes branch protection.

The trusted `pull_request_target` workflow checks out main only. PR code is
never run with its write token. Git objects are inspected as data, and the
allowed bump is checked against exact, narrowly scoped version substitutions.

## Local verification

```bash
python3 -m unittest discover -s tools -p 'test_release_*.py'
actionlint .github/workflows/version-sync.yml .github/workflows/release-handoff.yml
```

Tests use disposable Git repositories and fake GitHub responses. They never
push to Maple, publish artifacts, or create real release tags.
