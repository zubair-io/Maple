# Maple Jules reviewer

Adapted from [sanjay3290/jules-pr-reviewer](https://github.com/sanjay3290/jules-pr-reviewer/tree/432e901b3bc32353e7c75503421c64df4ffccc8b), commit `432e901b3bc32353e7c75503421c64df4ffccc8b`, the same action revision used by `_Maple/.github/workflows/jules-pr-review.yml` when inspected. The upstream MIT license is retained in `LICENSE`.

Local changes:

- Require completed session state and an explicit verdict before accepting a review.
- Delete only the current review session, after publishing its comment and commit status. Keep failed/unpublished sessions; report cleanup failures without overwriting review findings.
- Add cleanup tests and use Node 24.
- Update the locked transitive `undici` dependency to resolve the advisories reported by `npm audit`.

`action.yml`, `src/index.ts`, `src/prompt.ts`, and the build configuration originate upstream. `src/cleanup.ts` and its tests are local additions. Dependencies install from the lockfile and the workflow builds the action before executing it. `dist/`, `lib/`, and `node_modules/` are excluded from Git.

Ported from [Sugar Maple PR #29](https://github.com/zubair-io/Sugar-Maple/pull/29). Maple keeps its existing main-branch review triggers, instruction-only path exclusions, bypass label, status context and 60-minute review timeout.

The existing `JULES_API_KEY` repository secret is reused. Completed approve, comment and block reviews are deleted only after their GitHub comment and status are published. Failed, timed-out or unpublished reviews remain available. Deletion failure fails the workflow without replacing the saved review; HTTP 404 counts as already deleted. Manual cancellation or runner loss can still leave a session. Runs for the same PR are serialized without cancelling an active review.

To retry cleanup manually with `JULES_API_KEY` in your environment, replace `SESSION_ID` with the exact ID from the saved review:

```sh
curl --fail-with-body --request DELETE \
  --header "x-goog-api-key: $JULES_API_KEY" \
  'https://jules.googleapis.com/v1alpha/sessions/SESSION_ID'
```

This uses the [Jules session deletion API](https://jules.google/docs/api/reference/sessions). No account-wide session enumeration or bulk deletion occurs.

From this directory, validate with `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `npm run build`. Tests simulate API responses; live validation requires the configured Jules account.
