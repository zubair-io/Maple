# Separate native and display validation — #5000

The regional guard previously measured CIEDE2000 at native JPEG resolution,
while the physical acceptance check and visual review measure it after BOX
reduction to a maximum1024px long edge. That rejected the useful0004 correction
because native fine texture/registration error was counted as local display
color damage. The actual display-region increase was only0.00438DE.

Native RGB squared/absolute and global perceptual checks remain unchanged.
A separate display observation set now measures regional perceptual changes.
Both sets evaluate each native LUT pixel BEFORE averaging the footprint. The
camera JPEG is normalized to sRGB and8bit BEFORE resampling, with horizontal
and vertical byte rounding matching Pillow's22-bit resampler. Aspect cropping
and display dimensions use ties-to-even rounding, matching the comparator.

Three independent Pillow-generated PNG fixtures cover integer, fractional and
factor12downsampling, byte-for-byte at every target pixel. A separate witness
shows why native RGB safeguards and display perceptual regions are distinct:
a correct display average may improve while native fine-detail perceptual
matching worsens. The native RGB safeguards still apply. Existing global/local
damage witnesses remain in force. No acceptance limit or regional selection
margin is relaxed; Neutral AgX and output37/fit7 remain unchanged.

Primary implementation reference for byte rounding:
https://github.com/python-pillow/Pillow/blob/12.0.0/src/libImaging/Resample.c

Physical, full-corpus visual and host/GPU/banding qualification remain pending.
Keep existing draft5003open and unmerged. This is not a completed color fix.

## Pilot result

All nine previously changed/positive-control images were rendered with source
6d624a6da5.0002passes and the other eight still fail. Every output matches the
original baseline PNG hash: selection rejects every new candidate.62Auto unit
tests pass (6existing ignored). This does not clear a color failure.

To diagnose the actual rejection rather than guess, the existing stage-dump
diagnostic mode now also writes `auto_fit_selection.json` and the sampled
operator/target/prior snapshot `auto_fit_observations.json`. This is active only
when the stage-dump feature AND existing MAPLE_STAGE_DUMP directory are enabled.
MAPLE_STAGE_DUMP_ROI may keep EXR diagnostics tiny; the sampled operator is still
built from the full fit frame. Neither file is full RAW qualification by itself.
Normal rendering and all acceptance budgets remain unchanged.
