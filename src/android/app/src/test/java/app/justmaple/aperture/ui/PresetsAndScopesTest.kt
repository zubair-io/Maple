package app.justmaple.aperture.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.justmaple.aperture.MapleState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PresetsAndScopesTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun builtInPresetsMatchAppleCatalogAndDetectActiveState() {
        assertEquals(
            listOf(
                "builtin-flat",
                "builtin-high-contrast",
                "builtin-monochrome",
                "builtin-no-sharpening",
                "builtin-no-color-nr",
            ),
            builtInPresets.map { it.id },
        )
        val flat = builtInPresets.first { it.id == "builtin-flat" }
        assertFalse(MapleState(values = mapOf("contrast" to 0f)).isPresetActive(flat))
        assertTrue(MapleState(values = mapOf("contrast" to -50f)).isPresetActive(flat))
    }

    @Test
    fun histogramChipCyclesThroughHistogramWaveformParadeAndVectorscopeOnTap() {
        val density = listOf(1f, 0f, 0f, 1f)
        val sample = RgbHistogram(
            channels = List(3) { listOf(0.5f, 1f) },
            columns = 2,
            bins = 2,
            waveformLuma = density,
            paradeR = density,
            paradeG = density,
            paradeB = density,
            vectorscopeBins = 2,
            vectorscope = density,
        )
        compose.setContent { HistogramChip(Result.success(sample)) }

        val chip = compose.onNodeWithTag("editor-scopes-chip")
        chip.assertIsDisplayed()

        // Tap 1 -> Waveform
        chip.performClick()
        compose.onNodeWithText("WAVEFORM").assertIsDisplayed()

        // Tap 2 -> RGB Parade
        chip.performClick()
        compose.onNodeWithText("RGB PARADE").assertIsDisplayed()

        // Tap 3 -> Vectorscope
        chip.performClick()
        compose.onNodeWithText("VECTORSCOPE").assertIsDisplayed()

        // Tap 4 -> back to Histogram
        chip.performClick()
        compose.onNodeWithText("VECTORSCOPE").assertDoesNotExist()
    }

    @Test
    fun userPresetsEncodeDecodeAndTrackSavableFields() {
        val custom =
            listOf(
                BuiltInPreset(
                    id = "user-1",
                    name = "Warm Film",
                    fields = mapOf("exposure" to 0.5f, "contrast" to 15f),
                    userCreated = true,
                )
            )
        val decoded = decodeUserPresetsJson(encodeUserPresetsJson(custom))
        assertEquals(custom, decoded)

        val state =
            MapleState(
                values =
                    mapOf(
                        "exposure" to 0.75f,
                        "contrast" to 0f,
                        "temperature" to 5500f,
                        "_shot_temperature" to 5500f,
                        "_raw" to 1f,
                    )
            )
        assertEquals(mapOf("exposure" to 0.75f), state.savablePresetFields())
    }

    @Test
    fun toneCurveZoneAndValueMappingMatchParametricSplits() {
        assertEquals("parametric_shadows", toneCurveZoneFieldForX(0.10f))
        assertEquals("parametric_darks", toneCurveZoneFieldForX(0.35f))
        assertEquals("parametric_lights", toneCurveZoneFieldForX(0.60f))
        assertEquals("parametric_highlights", toneCurveZoneFieldForX(0.85f))
        assertEquals(0f, toneCurveValueForPoint(0.5f, 0.5f), 1e-4f)
        assertTrue(toneCurveValueForPoint(0.25f, 0.5f) > 0f)
        assertTrue(toneCurveValueForPoint(0.75f, 0.5f) < 0f)
    }
}
