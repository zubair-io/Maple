package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentFields
import app.justmaple.aperture.generated.AdjustmentTransfer
import app.justmaple.aperture.generated.AdjustmentTransferMode
import org.junit.Assert.*
import org.junit.Test

/**
 * The generated transfer table against Android's other raw-core-generated table,
 * AdjustmentFields. The row-by-row comparison with raw-core's own constants is
 * `adjustment_transfer_tests.rs` in the native crate.
 */
class AdjustmentTransferTableTest {
    private val grouped = AdjustmentTransfer.groups.flatMap { it.fields }

    @Test
    fun groupsArePresentedInRawCoreOrderAndEveryMemberHasADecision() {
        assertEquals(
            listOf("white_balance", "tone", "color", "detail", "effects", "geometry"),
            AdjustmentTransfer.groups.map { it.id },
        )
        assertEquals("White Balance", AdjustmentTransfer.groups.first().label)
        assertEquals("Each field belongs to one group", grouped.size, grouped.toSet().size)
        grouped.forEach { assertNotNull(it, AdjustmentTransfer.modes[it]) }
        assertEquals(AdjustmentTransferMode.Relative, AdjustmentTransfer.modes["temperature"])
        assertEquals(AdjustmentTransferMode.AssetRelative, AdjustmentTransfer.modes["crop"])
    }

    @Test
    fun everyNumericFieldWithAWireKeyIsCopiedOrDeliberatelyExcluded() {
        for (field in AdjustmentFields.all.filter { it.xmp.isNotEmpty() }) {
            val mode = AdjustmentTransfer.modes[field.name]
            assertNotNull(field.name, mode)
            assertEquals(field.name, field.xmp, AdjustmentTransfer.xmpAttributes.getValue(field.name).first())
            assertTrue(field.name, field.name in grouped || mode == AdjustmentTransferMode.Unsupported)
        }
    }

    @Test
    fun everyTransferredFieldHasAWireMappingAndEveryElementIsAKnotCurve() {
        for (group in AdjustmentTransfer.groups) for (field in group.transferredFields(raw = true)) {
            assertTrue(
                field,
                field in AdjustmentTransfer.xmpAttributes || field in AdjustmentTransfer.xmpElements,
            )
        }
        assertEquals(
            PointCurve.entries.map { it.element }.toSet(),
            AdjustmentTransfer.xmpElements.values.toSet(),
        )
    }

    @Test
    fun unsupportedFieldsAreNeverTransferredAndRawOnlyFieldsSkipRasters() {
        val excluded =
            listOf(
                "local_adjustments", "retouch_spots", "retouch_frame", "inpaint_removals",
                "mask_rasters", "lens_profile", "wb_sample_x", "wb_sample_y", "wb_algorithm_version",
                "capture_sharpening_radius", "temperature_seen", "tint_seen",
            )
        excluded.forEach { assertEquals(it, AdjustmentTransferMode.Unsupported, AdjustmentTransfer.modes[it]) }
        val rawTransfers = AdjustmentTransfer.groups.flatMap { it.transferredFields(raw = true) }
        val rasterTransfers = AdjustmentTransfer.groups.flatMap { it.transferredFields(raw = false) }
        assertTrue(rawTransfers.none { it in excluded })
        assertTrue(rasterTransfers.none { it in AdjustmentFields.rasterRestricted })
        assertTrue("capture_sharpening_amount" in rawTransfers)
        assertTrue("demosaic" in rawTransfers && "demosaic" !in rasterTransfers)
    }
}
