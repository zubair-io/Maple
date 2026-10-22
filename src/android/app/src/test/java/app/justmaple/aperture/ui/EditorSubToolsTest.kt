package app.justmaple.aperture.ui

import app.justmaple.aperture.generated.AdjustmentFields
import org.junit.Assert.*
import org.junit.Test

class EditorSubToolsTest {
    @Test
    fun lightExposesBasicAndToneCurveSubTools() {
        val subTools = subToolsFor(EditorGroup.Light)
        assertEquals(listOf("basic", "curve"), subTools.map { it.id })
        assertEquals(listOf("Basic", "Tone Curve"), subTools.map { it.label })
    }

    @Test
    fun toneCurveUsesParametricFieldsFromSchema() {
        val fields = fieldsForSubTool(EditorGroup.Light, "curve")
        assertEquals(
            listOf(
                "parametric_shadows",
                "parametric_darks",
                "parametric_lights",
                "parametric_highlights",
                "parametric_shadow_split",
                "parametric_midtone_split",
                "parametric_highlight_split",
            ),
            fields.map { it.name },
        )
        assertEquals(fields.map { it.name }, toneCurveFieldNames)
        for (field in fields) {
            assertSame(AdjustmentFields.byName.getValue(field.name), field)
        }
    }

    @Test
    fun colorExposesBasicWbPresetsAndHslSubTools() {
        val subTools = subToolsFor(EditorGroup.Color)
        assertEquals(listOf("basic", "wb", "hsl"), subTools.map { it.id })
    }

    @Test
    fun basicSubToolsMirrorExistingGroupSliders() {
        assertEquals(
            EditorGroup.Light.tools.map { it.field },
            fieldsForSubTool(EditorGroup.Light, "basic").map { it.name },
        )
        assertEquals(
            listOf("temperature", "tint", "vibrance", "saturation"),
            fieldsForSubTool(EditorGroup.Color, "basic").map { it.name },
        )
    }

    @Test
    fun hslCoversEightBandsWithHueSaturationAndLuminance() {
        assertEquals(8, HslBand.entries.size)
        assertEquals(
            listOf("Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"),
            HslBand.entries.map { it.label },
        )
        val all = HslBand.entries.flatMap(::hslBandFields)
        assertEquals(24, all.size)
        assertEquals(24, all.map { it.name }.distinct().size)
        for (band in HslBand.entries) {
            assertEquals(
                listOf(
                    "hue_adjustment_${band.key}",
                    "saturation_adjustment_${band.key}",
                    "luminance_adjustment_${band.key}",
                ),
                hslBandFields(band).map { it.name },
            )
        }
    }

    @Test
    fun whiteBalancePresetsCoverEightChipsWithFixedKelvinValues() {
        assertEquals(
            listOf(
                "As Shot",
                "Auto",
                "Daylight 5500K",
                "Cloudy 6500K",
                "Shade 7500K",
                "Tungsten 2850K",
                "Fluorescent 3800K",
                "Flash 5500K",
            ),
            wbPresets.map { it.label },
        )
        val kelvin = wbPresets.associate { it.label to it.temperature }
        assertEquals(5500f, kelvin.getValue("Daylight 5500K"))
        assertEquals(6500f, kelvin.getValue("Cloudy 6500K"))
        assertEquals(7500f, kelvin.getValue("Shade 7500K"))
        assertEquals(2850f, kelvin.getValue("Tungsten 2850K"))
        assertEquals(3800f, kelvin.getValue("Fluorescent 3800K"))
        assertEquals(5500f, kelvin.getValue("Flash 5500K"))
    }

    @Test
    fun whiteBalancePresetEditsSetTemperatureAndTint() {
        for (preset in wbPresets.filter { it.temperature != null }) {
            val edits = wbPresetEdits(preset)
            assertNotNull(edits)
            assertEquals(setOf("temperature", "tint"), edits!!.keys)
            assertEquals(preset.temperature, edits.getValue("temperature"))
            assertEquals(preset.tint, edits.getValue("tint"))
            val temperature = AdjustmentFields.byName.getValue("temperature")
            val tint = AdjustmentFields.byName.getValue("tint")
            assertTrue(edits.getValue("temperature") in temperature.minimum..temperature.maximum)
            assertTrue(edits.getValue("tint") in tint.minimum..tint.maximum)
        }
    }

    @Test
    fun asShotAndAutoResetTemperatureAndTint() {
        for (label in listOf("As Shot", "Auto")) {
            val preset = wbPresets.single { it.label == label }
            assertNull(wbPresetEdits(preset))
        }
    }

    @Test
    fun groupsExposeExpectedSubToolsAndFullInspectorFields() {
        assertEquals(listOf("basic", "presets"), subToolsFor(EditorGroup.Effects).map { it.id })
        assertEquals(listOf("basic", "crop"), subToolsFor(EditorGroup.Detail).map { it.id })
        assertEquals(
            EditorGroup.Detail.fields.map { it.name },
            fieldsForSubTool(EditorGroup.Detail, "basic", fullInspector = true).map { it.name },
        )
    }
}
