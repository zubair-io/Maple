# Repair-spot sidecars

Hand-authored XMP sidecars in the shapes Lightroom writes for clone / heal spots (`docs/xmp-canonical-format.md` § "Repair spots"). They were not saved by Lightroom and are not pixel references; they pin the structure the Android repair writer (#5904) must read and preserve.

`lightroom-spots.xmp` has no `papp:` markup, so raw-core reads its list as upright. It holds three `crs:RetouchAreas` entries:

1. A heal spot whose source is Adobe's offset form (`crs:OffsetX`/`crs:OffsetY`) with `crs:SourceState="sourceAutoComputed"`, a non-zero `crs:Seed`, `crs:Flow` and `crs:CenterWeight`, Adobe sync IDs, a vendor attribute and a vendor child element.
2. A clone spot in the canonical `crs:SourceX`/`crs:SourceY` form.
3. A brush heal (`crs:Method="brush"`, `Mask/Paint`), which raw-core does not model and every writer keeps verbatim.

A vendor element follows the container, outside the repair list.

`lightroom-legacy-info.xmp` carries two spots only in the pre-struct `crs:RetouchInfo` string form, which raw-core reads and no writer emits. A repair edit converts it to the struct container.
