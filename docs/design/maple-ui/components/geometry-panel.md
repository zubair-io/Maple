# Manual geometry panel

**Tier:** Organism

## Purpose

Adjust horizontal and vertical perspective, rotation, aspect, and scale on the focused image
([#2435](https://github.com/zubair-io/Maple/issues/2435)). The controls work independently of
whether an optical lens profile is available. The image retains its frame dimensions; pixels
outside the transformed image are black. Crop applies after manual geometry.

## States and interaction

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

## Composition and accessibility

Web uses labeled `MuiLivingSliderComponent` instances in a section named “Manual geometry”.
It appears below optical lens corrections. Windows uses the existing adjustment-slider rows
under the Geometry tool. Each control retains the slider's focus, arrow-key, reset, and
disabled behavior. Layout uses the surrounding inspector typography and spacing.

## Rendering and persistence

The shared core prepares the projective transform for CPU rendering, GPU uniforms, and
coordinate tests. The GPU applies it after the display color stages and before quantization;
identity omits the pass. These controls do not invalidate the decode prefix. Mask handles and
tint project from their saved original coordinates through manual geometry and crop.

XMP uses `papp:GeoPerspectiveH`, `papp:GeoPerspectiveV`, `papp:GeoRotation`, `papp:GeoAspect`,
and `papp:GeoScale`. Identity values are omitted by the canonical core serializer.
