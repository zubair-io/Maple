# Manual geometry panel

**Tier:** Organism

## Purpose

Adjust horizontal and vertical perspective, rotation, aspect, and scale on the focused image
([#2435](https://github.com/zubair-io/Maple/issues/2435)). The controls work independently of
whether an optical lens profile is available. The image retains its frame dimensions; pixels
outside the transformed image are black. Crop applies after manual geometry.

## Variants

Web renders a stacked inspector section below optical corrections. Windows renders the same five controls in its Geometry tool using native adjustment rows. There is no compact or Apple variant in this implementation.

## States

The panel is disabled without a focused image. Pointer and keyboard gestures update the live
render and create one undo checkpoint per gesture. Reset returns an individual control to its
identity value. Saved adjustments and Geometry copy/paste include all five values.

| Control                     | Range       | Identity | Step  |
| --------------------------- | ----------- | -------- | ----- |
| Horizontal perspective      | -0.4 to 0.4 | 0        | 0.005 |
| Vertical perspective        | -0.4 to 0.4 | 0        | 0.005 |
| Rotation, clockwise degrees | -180 to 180 | 0        | 0.1   |
| Aspect ratio multiplier     | 0.5 to 2    | 1        | 0.01  |
| Scale                       | 0.25 to 4   | 1        | 0.01  |

## Accessibility

Web uses labeled `MuiLivingSliderComponent` instances in a section named “Manual geometry”.
It appears below optical lens corrections. Windows uses the existing adjustment-slider rows
under the Geometry tool. Each control retains the slider's focus, arrow-key, reset, and
disabled behavior. Layout uses the surrounding inspector typography and spacing.

## Tokens used

The panel inherits the inspector's foreground, background, and font family. Slider tracks, focus rings, disabled opacity, and value typography use the existing living-slider component tokens. The section adds a 0.75rem row gap and 1rem top padding; it introduces no new color or motion tokens.

## Props

The Web panel has no public inputs or outputs. It reads the focused asset's adjustment signal from `LibraryStateService`, derives slider ranges from the generated adjustment table, and writes through the existing gesture/undo API. Windows reads and writes the corresponding fields on the active edit session.

## Rendering and persistence

The shared core prepares the projective transform for CPU rendering, GPU uniforms, and
coordinate tests. The GPU applies it after the display color stages and before quantization;
identity omits the pass. These controls do not invalidate the decode prefix. Mask handles and
tint project from their saved original coordinates through manual geometry and crop.

XMP uses `papp:GeoPerspectiveH`, `papp:GeoPerspectiveV`, `papp:GeoRotation`, `papp:GeoAspect`,
and `papp:GeoScale`. Identity values are omitted by the canonical core serializer.
