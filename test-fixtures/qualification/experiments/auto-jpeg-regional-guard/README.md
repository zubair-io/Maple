# Regional selection guard — source548751db18

Complete20fixture replay:1JPEG pass,15failures,4previewless cases,0errors.
All four previewless decoded Auto/Neutral comparisons pass.59Auto unit checks
pass with six existing ignored. This is NOT a completed color fix.

The guard prevents the source5b6local regressions, but also rejects the useful
0004candidate. The current internal regional CIEDE measurement is at the native
JPEG resolution, whereas the harness/visual CIEDE measurement follows BOX
reduction to1024pixels. Actual display-region change on0004is at worst+0.00438DE,
and source5b6passed every absolute gate for it. Native fine texture/registration
error must not be confused with display-scale color change.

Next: compute separate display-scale eval-then-BOX observations for local
perceptual selection, normalizing the JPEG to sRGB/8bit BEFORE BOX reduction,
while retaining the native RGB error guards. Keep every existing acceptance
limit and the added0.1internal regional margin unchanged. Do not loosen the
guard to obtain acceptance. Continue the complete corpus after focused proof;
keep draft5003unmerged and goal active. Output37/fit7 and Neutral AgX unchanged.
