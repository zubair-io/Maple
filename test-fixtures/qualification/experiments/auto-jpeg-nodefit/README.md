# Direct tetrahedral JPEG-band fit candidate — #5000

The previous constrained-curve pilot is preserved separately:8cases,zero clears,
zero new failures. This candidate instead builds the linear per-band mean
operator of the actual baked tetrahedral LUT. Five band constraints share a
smooth correction basis; a small dual solve updates the nodes with bounded,
isotonic projections along channel axes and equal-RGB brightness directions.
It preserves the structured model as its starting point and retains the best
measured solution. No per-camera constants, input replacements or JPEG-budget
changes are used. The native RGB frame remains unchanged.

Footprints use the physical gate's BOX pixel centers (including upscale),
0.001 aspect-crop threshold and ties-even border/crop rounding. Adobe-RGB JPEG
normalization is quantized exactly like the independently extracted reference.
The older curve API and solver are restored unchanged; their failed pilot's
mapped-curve plumbing is removed.

56Auto unit checks pass, including tetrahedral-weight agreement with the real
sampler, independent Pillow BOX witnesses, positive brightness ordering,
bounded isotonic projection and unchanged source pixels.6existing fixture
checks are ignored.7real GPU residual-LUT parity tests pass at their existing
bounds. The8case physical pilot is underway; no physical clear or complete
suite result is claimed in this checkpoint.

Output37/fit7 and NeutralAgX unchanged. Same draft5003, no merge.
