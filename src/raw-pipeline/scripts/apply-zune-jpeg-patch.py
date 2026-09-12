#!/usr/bin/env python3
"""Apply Maple's #3596 patch to a zune-jpeg 0.5.x source tree.

Three hunks in src/mcu.rs, all confined to the NON-INTERLEAVED multi-scan
baseline path (`!all_components_in_first_scan`). See MAPLE-PATCH.md.
"""
import pathlib
import sys

HUNKS = [
    # 1. Per-scan data-unit ROW count.
    (
        """            trace!("Decoding MCU width: {mcu_width}, height: {mcu_height}");

            for i in 0..mcu_height {""",
        """            trace!("Decoding MCU width: {mcu_width}, height: {mcu_height}");

            // Data-unit ROWS this scan actually codes.
            //
            // A non-interleaved scan (Ns=1) codes its component's own data
            // units in raster order (T.81 A.2.2), so the row count is
            // ceil(component height / 8) — NOT the interleaved MCU row count,
            // which is short by that component's vertical sampling factor. On
            // a 4:2:0 image the luma component therefore had exactly half its
            // block rows decoded and the bitstream desynchronised at the end
            // of the scan. (Maple patch, #3596.)
            let scan_rows = if all_components_in_first_scan {
                mcu_height
            } else {
                let comp = &self.components[self.z_order[0]];
                (usize::from(self.info.height) * comp.vertical_sample + self.v_max * 8 - 1)
                    / (self.v_max * 8)
            };

            for i in 0..scan_rows {""",
    ),
    # 2. Thread "this scan still owes rows" into the two row-decoding calls.
    (
        """                    self.decode_mcu_width::<false>(
                        mcu_width,
                        i,
                        &mut tmp,
                        &mut stream,
                        &mut progressive_mcus
                    )?""",
        """                    self.decode_mcu_width::<false>(
                        mcu_width,
                        i,
                        false,
                        &mut tmp,
                        &mut stream,
                        &mut progressive_mcus
                    )?""",
    ),
    (
        """                    self.decode_mcu_width::<true>(
                        mcu_width,
                        i,
                        &mut tmp,
                        &mut stream,
                        &mut progressive_mcus
                    )?""",
        """                    self.decode_mcu_width::<true>(
                        mcu_width,
                        i,
                        i + 1 < scan_rows,
                        &mut tmp,
                        &mut stream,
                        &mut progressive_mcus
                    )?""",
    ),
    (
        """    fn decode_mcu_width<const PROGRESSIVE: bool>(
        &mut self, mcu_width: usize, mcu_height: usize, tmp: &mut [i32; 64],
        stream: &mut BitStream, progressive: &mut [Vec<i16>; 4]
    ) -> Result<McuContinuation, DecodeErrors> {""",
        """    fn decode_mcu_width<const PROGRESSIVE: bool>(
        &mut self, mcu_width: usize, mcu_height: usize, more_rows_in_scan: bool,
        tmp: &mut [i32; 64], stream: &mut BitStream, progressive: &mut [Vec<i16>; 4]
    ) -> Result<McuContinuation, DecodeErrors> {""",
    ),
    (
        """            self.inner_decode_mcu_width::<PROGRESSIVE, false>(
                mcu_width,
                mcu_height,
                tmp,
                stream,
                progressive
            )""",
        """            self.inner_decode_mcu_width::<PROGRESSIVE, false>(
                mcu_width,
                mcu_height,
                more_rows_in_scan,
                tmp,
                stream,
                progressive
            )""",
    ),
    (
        """            self.inner_decode_mcu_width::<PROGRESSIVE, true>(
                mcu_width,
                mcu_height,
                tmp,
                stream,
                progressive
            )""",
        """            self.inner_decode_mcu_width::<PROGRESSIVE, true>(
                mcu_width,
                mcu_height,
                more_rows_in_scan,
                tmp,
                stream,
                progressive
            )""",
    ),
    (
        """    fn inner_decode_mcu_width<const PROGRESSIVE: bool, const SAMPLED: bool>(
        &mut self, mcu_width: usize, mcu_height: usize, tmp: &mut [i32; 64],
        stream: &mut BitStream, progressive: &mut [Vec<i16>; 4]
    ) -> Result<McuContinuation, DecodeErrors> {""",
        """    fn inner_decode_mcu_width<const PROGRESSIVE: bool, const SAMPLED: bool>(
        &mut self, mcu_width: usize, mcu_height: usize, more_rows_in_scan: bool,
        tmp: &mut [i32; 64], stream: &mut BitStream, progressive: &mut [Vec<i16>; 4]
    ) -> Result<McuContinuation, DecodeErrors> {""",
    ),
    (
        """        self.check_stream_marker_after_mcu_width(stream)
    }

    fn check_stream_marker_after_mcu_width(
        &mut self, stream: &mut BitStream
    ) -> Result<McuContinuation, DecodeErrors> {""",
        """        self.check_stream_marker_after_mcu_width(stream, more_rows_in_scan)
    }

    fn check_stream_marker_after_mcu_width(
        &mut self, stream: &mut BitStream, more_rows_in_scan: bool
    ) -> Result<McuContinuation, DecodeErrors> {""",
    ),
    # 3. One block row per data-unit row, not `vertical_sample` of them.
    (
        """                let channel = if PROGRESSIVE {
                    let offset =
                        mcu_height * component.width_stride * 8 * component.vertical_sample;""",
        """                let channel = if PROGRESSIVE {
                    // `mcu_height` is the row INDEX here, and for a
                    // non-interleaved scan it counts the component's own
                    // data-unit rows, one block row each — so the pitch is one
                    // block row, not the `vertical_sample` block rows an
                    // interleaved MCU row spans. Multiplying by
                    // `vertical_sample` left every other luma block row of a
                    // 4:2:0 image zeroed. (Maple patch, #3596.)
                    let offset = mcu_height * component.width_stride * 8;""",
    ),
    # 4. A pending marker is not the end of a scan that still owes rows.
    (
        """            } else if let Marker::SOS = m {
                self.parse_marker_inner(m)?;""",
        """            } else if more_rows_in_scan
                && (matches!(m, Marker::SOS | Marker::DHT | Marker::DQT | Marker::DRI | Marker::COM)
                    || matches!(m, Marker::APP(_)))
            {
                // A PENDING marker is not the end of this scan.
                //
                // The bit reader runs up to 8 bytes ahead of the coefficients
                // it has handed out, so a short scan — a flat chroma channel,
                // a small image, anything whose entropy data is under ~8 bytes
                // per data-unit row — has the NEXT scan's `SOS` (or the `DHT`
                // libjpeg writes in front of it) sitting in `stream.marker`
                // long before its own data units are used up. Honouring it
                // here ended that scan after its first row and left the rest
                // of the component at zero.
                //
                // The scan's own data-unit rows say when it is over, so the
                // marker stays pending until then. `RST`, `EOI` and anything
                // unrecognised are still handled immediately below — restart
                // intervals are part of the scan, and an early `EOI` means the
                // file really is truncated. (Maple patch, #3596.)
                trace!("Deferring marker {:?} — scan still owes data-unit rows", m);
                return Ok(McuContinuation::Ok);
            } else if let Marker::SOS = m {
                self.parse_marker_inner(m)?;""",
    ),
    # 5. A marker we cannot parse ends the image, it does not fail the decode.
    (
        """            } else if let Marker::SOS = m {
                self.parse_marker_inner(m)?;
                stream.marker.take();
                stream.reset();
                trace!("Found SOS marker");
                return Ok(McuContinuation::AnotherSos);""",
        """            } else if let Marker::SOS = m {
                // In non-strict mode a marker we cannot PARSE is the end of
                // what this file can give us, not a decode failure. A JPEG
                // truncated inside a later scan header leaves a partial `SOS`
                // segment — and a non-interleaved file has one scan header
                // per component, so there are three places to be cut instead
                // of one. Propagating the parse error threw away every row
                // that had already decoded; the sibling handling for a failed
                // coefficient block takes the same recover-what-we-have view,
                // as this module's own doc says ("allows even corrupt images
                // to render something ... matching browsers").
                // (Maple patch, #3596.)
                if let Err(e) = self.parse_marker_inner(m) {
                    if self.options.strict_mode() {
                        return Err(e);
                    }
                    error!("{}", e);
                    stream.marker.take();
                    stream.reset();
                    return Ok(McuContinuation::Terminate);
                }
                stream.marker.take();
                stream.reset();
                trace!("Found SOS marker");
                return Ok(McuContinuation::AnotherSos);""",
    ),
]


def main() -> int:
    root = pathlib.Path(sys.argv[1])
    path = root / "src/mcu.rs"
    src = path.read_text()
    if "Maple patch, #3596" in src:
        print(f"    {path}: already patched")
        return 0
    for old, new in HUNKS:
        n = src.count(old)
        if n != 1:
            print(f"ERROR: expected 1 occurrence, found {n}, for:\n{old[:90]}...", file=sys.stderr)
            return 1
        src = src.replace(old, new)
    path.write_text(src)
    print(f"    {path}: patched ({len(HUNKS)} hunks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
