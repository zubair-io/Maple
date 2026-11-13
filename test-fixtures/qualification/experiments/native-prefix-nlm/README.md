# Native-camera dispatch after the NLM repair

Experimental control; not adopted. All93 focused comparisons complete with11 failures and20/20 Auto baselines passing; zero comparison errors and all158 touched inputs and renderer hashes unchanged. Matched source37:10 clears and7 regressions. Matched captured main within this cohort:9 clears and6 regressions. These are focused results; do not infer a full806case remaining count.

All existing29 AMaZE tests pass. The Panasonic exposure_min worst pixel persists from captured main but shifts from RGB18,3,10 to18,2,12 at matched9MP coordinates2054,1396; its maximum becomes7.9853 versus7.90. The separate affine-continuity trial does not alter this maximum. This broad dispatch change remains an experimental comparison while the independent NLM center-weight floor is investigated. Pipeline version stays37. Original reference bytes/settings/budgets are unchanged.
