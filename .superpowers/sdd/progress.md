# Progress ledger — Person-page merge suggestions

Plan: docs/superpowers/plans/2026-07-14-person-merge-suggestions.md
Design: docs/superpowers/specs/2026-07-14-person-merge-suggestions-design.md

(Prior ledger contents from an unrelated, already-merged plan backed up at
.superpowers/sdd/progress-backup-advanced-search-plan.md)

Pre-flight plan review: clean — verified Bbox already imported in
people.repo.ts and tsconfig.lib.json exists at the assumed path. No
conflicts to raise.

Started a throwaway mongod on 127.0.0.1:27077 (dbpath /tmp/maple-test-mongo-27077,
background task bw5ka4e8u) so Mongo-backed tests run for real instead of
skip-passing for the rest of this plan's execution.

Task 1: complete (commit 077d7ed3d..76e1a8ffe, review clean — spec compliant,
1 cosmetic-only minor note, tests re-verified for real against :27077 — 2 pass)

Task 2: complete (commit 76e1a8ffe..528daf1bb, incl. fix commit — spec compliant,
8/8 tests pass both before/after; 1 Important plan-mandated finding (mutable-loop
style vs CLAUDE.md immutability convention) — human chose to fix; refactored to
reduce()-based bestMatchFor helper, re-reviewed clean, Approved)

NOTE: extended multi-hour safety-classifier outage specifically blocking Agent/
ScheduleWakeup dispatch occurred during Tasks 2's review + fix cycle (intermittent
~1-in-15 success rate). Applied Task 2's fix directly (controller-authored Edit,
not a dispatched subagent) as a pragmatic exception, then got independent
re-review once dispatch recovered. If this recurs on later tasks, same fallback:
verify test evidence directly via Bash, apply small plan-mandated fixes directly,
still get independent review once dispatch is available.

Task 10: implemented directly (Agent dispatch effectively unavailable for a very
extended stretch — dozens of consecutive failures). commit 669233483..6c7259e86.
4/4 tests pass. Real bug found+fixed in the PLAN's own test code (bare vi.fn()
doesn't satisfy PeopleBulkDeps.toast's type under this vitest version — needed
vi.fn<(text,tone)=>void>()). Review still pending — dispatch kept failing.

Task 11: also implemented directly (same outage). commit 6c7259e86..0447e727d.
Full live golden-path verification done in the real dev server (see task-11-report.md):
badge visible, banner content correct, dismiss clears both docs + records dismissal,
merge confirmed correct FIXED direction via DB state (viewed person always survives).
Found+fixed an unrelated environment issue: a stale pre-session maple-api process
wasn't picking up any of today's commits — restarted it. Both Task 10 and 11 still
need independent review once Agent dispatch recovers.

Task 12: complete. Full API suite 2542 pass/1 skip/0 fail. Full web suite 1225 pass/
0 fail (114 files). Prettier format:check found 2 non-code files needing formatting
(the plan + design docs themselves) — fixed via `bun run format`, committed
(c9611041c). GitHub issue #2026 opened + tagged to Files board:
https://github.com/zubair-io/Maple/issues/2026. Stopped the verification dev servers.

Task 10: review completed after classifier recovered — Approved, zero Critical/
Important beyond the already-known plan-mandated vi.fn() typing bug. Reviewer
independently verified the fixed direction is structurally guaranteed by the code.

Task 11: review completed — Approved, zero issues. Reviewer independently traced
mergeSuggestionInto → performMerge to confirm the report's live-browser verification
narrative is logically consistent with the actual code, not just plausible prose.
MINOR (no action): report didn't explicitly confirm post-merge face-count display
(likely moot, synthetic people had 0 faces) — not a code defect.

ALL 12 TASKS COMPLETE AND REVIEWER-APPROVED. Proceeding to final whole-branch review.

FINAL WHOLE-BRANCH REVIEW (opus, base c0aedb3ab, head c9611041c): traced the full
compute→persist→serve→act→reconcile loop end-to-end; wire contracts verified
consistent on both sides, merge direction correct, dismiss asymmetry-safe +
idempotent, additive/backward-compatible schema, no injection surface. Zero
Critical. One Important: dismissSuggestion() didn't gate on peopleBulkBusy,
contradicting the design's explicit in-flight requirement (low real-world impact,
dismiss is idempotent, but a real deviation). 3 Minor (self-heals/informational,
no action): badge vs banner use different staleness-defensiveness rules; self-heal
doesn't reach a person who loses their centroid entirely; route logic has no
dedicated test file (matches house convention, not a gap).

Fix dispatched for the one Important finding: commit 13b9da1f1 "dismissSuggestion
gates on peopleBulkBusy, matching mergeSuggestionInto" — increments/decrements the
counter exactly like performMerge, guard-before-increment preserved, new test with
a genuinely deferred promise proves the 0→1→0 transition. Re-reviewed and Approved
(5/5 tests real pass, no unrelated changes).

CORRECTION on Task 12's "full regression pass": `bun run test` (`ng test` bare) only
runs the `maple-common` project (1225 tests) — it does NOT include the `maple`
project, where Tasks 10/11 actually live. Caught this during finishing-a-development-
branch's test-verification step and ran `bunx ng test maple --watch=false` explicitly:
11 files, 199 tests, all pass, 0 fail. Both web projects now confirmed genuinely green.

ALL WORK COMPLETE. GitHub issue #2026 open (Files board). Ready for
finishing-a-development-branch. Outage continued
intermittently through Task 3 (still ~1-in-4 to 1-in-5 success rate on Agent
dispatch) — kept retrying per user's explicit choice, no further manual fixes needed.

Throwaway mongod note: the controller's original :27077 instance (PID from
background task bw5ka4e8u, dbpath /tmp/maple-test-mongo-27077) died at some
point — dispatched subagents run in a separate sandbox and can't see the
controller's background processes anyway. The Task 3 implementer started its
own :27077 mongod at .../scratchpad/mongo-27077-data, which is now the shared
live instance for the rest of this session (confirmed reachable, 17/17 real
passes independently re-verified by the controller after Task 3).

Task 3: complete (commit 528daf1bb..4560e34a6, review clean — spec compliant,
zero issues, 3 new tests + full clustering-job.test.ts 17/17 passing for real
against :27077; one verified brief-vs-file deviation (bare mongoReachable var,
not h.mongoReachable) correctly matches this file's actual established
convention, not a shortcut)

Task 4: complete (commit 4560e34a6..34228a03b, review clean — spec compliant,
persistMergeSuggestions correctly iterates seedPersonIds (not mergeSuggestions)
so self-healing null-clear is guaranteed; new end-to-end test (write→hide→
re-run→verify-null) genuinely passes, full file 18/18 real pass against :27077.
MINOR (deferred to final review, no action needed): test assertions use `?? null`
which can't distinguish explicit-null from field-omitted — a future regression
to "skip" wouldn't be caught by this specific style; also freshB's score isn't
asserted (only its person_id). Neither is a shipped-code defect.

Task 5: complete (commit 34228a03b..36c0b9449, review clean — spec compliant,
all 3 correctness constraints verified (.equals() ObjectId compare, conditional
asymmetric clear via compound filter, idempotent upsert not insertOne), 4/4
real pass against :27077). MINOR (no action, order-dependent not a live bug):
person_merge_dismissals isn't cleared per-test in the shared test helper, test 1's
unfiltered findOne({}) only works because it runs first; also a narrow TOCTOU
window inherited verbatim from the plan's own prescribed code (no transaction),
not an implementer defect.

Task 6: complete (commit 36c0b9449..6c1de62fc, review clean — spec compliant,
reuses the already-open peopleCollection() handle, defensive merged_into/hidden
guard correct, 4 new tests + full people.repo.test.ts 25/25 real pass against
:27077, no regressions, correctly left route wiring for Task 7). MINOR (no
action): harmless drive-by removal of a redundant `as PersonWithId` cast beyond
brief scope; coverBbox round-trip not directly asserted (verbatim from brief).

Task 7: complete (commit 6c1de62fc..395fee9f5, review clean — zero issues,
no route test file per this codebase's convention (correctly not flagged as a
gap), full API suite re-verified independently: 2542 pass/1 skip/0 fail across
287 files, zero regressions). API BACKEND HALF OF THE PLAN (Tasks 1-7) DONE.
Web tasks (8-11) + final verification (12) + whole-branch review remain.

Task 8: complete (commit 395fee9f5..57c573181, review clean — zero issues,
wire shapes cross-verified against real src/api/src/routes/people.ts (not just
the brief's prose) — field names/nullability match exactly; no spec file added
per convention; typecheck clean (2 pre-existing unrelated errors, unchanged)).

NOTE: classifier outage recurred heavily during Task 8's review dispatch
(~8 consecutive failures before success) — kept retrying per standing user
policy, no manual fallback needed this time.

Task 9: complete (commits 57c573181..45717a61d..669233483, review clean —
dismissMergeSuggestion matches brief exactly, 2 new tests real pass, 23/23 full
file). IMPORTANT CROSS-TASK REGRESSION found+fixed: Task 8's new REQUIRED
fields (ApiPerson.hasMergeSuggestion, ApiPersonDetail.suggestedMerge) broke
BOTH people.store.spec.ts (maple-common) AND people.vm.spec.ts (maple project)
fixture builders — Task 8's own verification only checked tsconfig.lib.json,
which excludes specs, so this slipped through Task 8's review too. Task 9's
implementer fixed the maple-common one in-scope + flagged the maple one;
controller fixed that one directly (mongod/Bash outage-style fallback, applied
here for a different reason: no later task naturally touches those fixtures).
Both verified 23/23 and 62/62 real pass. Lesson for final review: typecheck
gates that exclude spec files can hide real breaks — worth a note in the
final whole-branch review.
