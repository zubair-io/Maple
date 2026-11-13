# Fine LUT refinement: rejected candidate and protected pilot

The full goal remains incomplete. Draft #5003 must not merge.

## Rejected source a431aa4731

The complete physical suite reports 9 JPEG passes, 7 failures, 4 exact no-preview fallbacks and no errors. Test 0010 newly passes. All 99 Auto unit tests (6 existing ignored), 8 host/cache tests, 7 GPU LUT tests and the 5 canonical test0000 ramp checks pass.

An additional test0010 cross-camera ramp diagnostic rejects accepting this candidate: neutral flat-run fraction rises from 0.0283479961 to 0.0615835777, with increased red/green drift. The prior checkpoint also fails the unchanged test0000 neutral ceilings when applied to test0010; this is an existing separate defect, not a passing baseline. Other four color ramps pass before and after. No ceiling was changed.

## Protected source 9ebc50a4c1

The fine solve and constraint projections now fix every neutral-axis LUT node to the existing selected artifact. Five targeted tests pass, including exact equality over 1024 neutral samples. The real test0010 photo still passes every physical image check. Its neutral diagnostic JSON exactly matches the previous checkpoint, and all four color ramps pass. The complete 20-fixture run and full regression qualification are pending; this pilot is not a qualified full checkpoint.

The accepted full checkpoint remains 91fa556d44: 8 passes, 8 failures, 4 exact fallbacks. Preserve Neutral AgX, pipeline37, fit7, all source bytes and fixed thresholds. All full-resolution renders remain external under the two evidence directories named in identity.json. No merge or version bump.
