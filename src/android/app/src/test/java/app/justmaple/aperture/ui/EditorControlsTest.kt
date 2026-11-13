package app.justmaple.aperture.ui

import org.junit.Assert.*
import org.junit.Test

class EditorControlsTest {
    @Test
    fun cropHasNoAdjustmentSliderFieldsInEitherControlLayout() {
        assertTrue(fieldsForSubTool(EditorGroup.Detail, "crop").isEmpty())
        assertTrue(fieldsForSubTool(EditorGroup.Detail, "crop", fullInspector = true).isEmpty())
    }

    @Test
    fun inspectorDoesNotExposeCurveHslOrTechnicalFieldsAsLooseSliders() {
        val names = EditorGroup.entries.flatMap { it.fields }.map { it.name }
        assertFalse(names.any { it.startsWith("parametric_") })
        assertFalse(names.any { it.contains("_adjustment_") })
        assertFalse(names.any { it.startsWith("wb_") })
        assertFalse(names.contains("capture_sharpening_radius"))
        assertEquals(names.size, names.distinct().size)
    }

    @Test
    fun retainsIosNoiseControlsAndEveryExistingPhoneTool() {
        val detail = EditorGroup.Detail.fields.map { it.name }
        assertTrue(detail.containsAll(listOf("nr_luminance", "nr_color", "deep_denoise", "chroma_prefilter")))
        for (group in EditorGroup.entries) {
            assertTrue(group.fields.map { it.name }.containsAll(group.tools.map { it.field }))
        }
    }
}
