# Progress ledger — Advanced Search hidden filter + batch metadata editor

Plan: docs/superpowers/plans/2026-07-07-advanced-search-hidden-filter-and-batch-metadata.md

(Previous ledger contents from an unrelated, already-merged plan backed up at
.superpowers/sdd_new_tmp/old-progress-backup.md)

Task 1: complete (commit cc1fb34b8..2fd826cb0, review clean — spec compliant, no issues)
Task 2: complete (commit 2fd826cb0..5c06acada, review clean — spec compliant, no issues)
Task 3: complete (commit 5c06acada..3e711ddc6, review clean — spec compliant, no issues)
(chore 689aa25cb: synced pre-existing bun-security-scanner devDependency from origin/main, unrelated to feature tasks)
Task 4: complete (commit 3e711ddc6..2cbd482b5, review clean — spec compliant, no issues)
Task 5: complete (commit 689aa25cb..9c8b6f46b, review clean — spec compliant, no issues, live-verified in dev server)
Task 6: complete (commit 9c8b6f46b..3109c4f6d, review clean — spec compliant; reviewer traced address-vs-id safety path directly since live end-to-end wasn't possible in sandbox; 2 minor notes only)
Final whole-branch review (opus, base 0dc9d5827): found 1 Important (stale searchCache on batch-dismiss refresh) + 3 Minor. Fix commit 6e0c5376a addressed all 3 actionable items; re-review confirmed all fixed, no new issues, Ready to merge: Yes.
Task 7: complete — issue #1847 (Files board), PR #1848 opened (main <- claude/lucid-bohr-d47e55). ALL TASKS DONE.

PR #1848 CI + bot review round: Jules + Copilot both flagged the checkbox keydown-bubbling bug (fixed f0a6279/PR follow-up); Copilot additionally caught stale facets not refreshed on batch-dismiss (fixed); CI red on 3 checks after push:
- web-test (Maple-common): REAL — maple-common's sibling SearchComponent spec fixtures predated the `address` field, TS2741. Fixed both fixture sites (search.component.spec.ts).
- fallow-audit-api complexity: projectAsset (62 lines) and listRoute (164 lines) over threshold. Extracted computeAddress() helper from projectAsset (now 58 lines, lower cyclomatic). listRoute's 164 lines / cyclomatic 23 predates this PR (added only ~4 lines via Promise.all) — NOT refactored, flagged to user as pre-existing debt, out of scope for this feature.
- fallow-audit-api unused deps (7, all @opentelemetry/*/meilisearch): pre-existing, unrelated to any file this PR touches — not actionable here.
- jules/review: re-run pending after push.
