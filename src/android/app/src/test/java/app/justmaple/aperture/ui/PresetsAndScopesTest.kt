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
    fun userPresetsEncodeDecodeAndTrackSavableFieldsAndAttributes() {
        val custom =
            listOf(
                BuiltInPreset(
                    id = "user-1",
                    name = "Warm Film",
                    fields = mapOf("exposure" to 0.5f, "contrast" to 15f),
                    attributes = mapOf("papp:FilmLook" to "kodak_portra_400", "crs:ConvertToGrayscale" to "True"),
                    userCreated = true,
                )
            )
        val decoded = decodeUserPresetsJson(encodeUserPresetsJson(custom))
        assertEquals(custom, decoded)

        // Preset with only non-numeric look attributes also round-trips and detects active state
        val lookOnly =
            listOf(
                BuiltInPreset(
                    id = "user-2",
                    name = "Portra Only",
                    fields = emptyMap(),
                    attributes = mapOf("papp:FilmLook" to "kodak_portra_400", "papp:Profile" to "Neutral"),
                    userCreated = true,
                )
            )
        val decodedLookOnly = decodeUserPresetsJson(encodeUserPresetsJson(lookOnly))
        assertEquals(lookOnly, decodedLookOnly)

        // Forward-compatible unknown fields/attributes are preserved on round-trip
        val forwardCompat =
            listOf(
                BuiltInPreset(
                    id = "user-3",
                    name = "Future Preset",
                    fields = mapOf("exposure" to 0.25f, "future_slider_v99" to 42f),
                    attributes = mapOf("papp:FutureAttr" to "enabled"),
                    userCreated = true,
                )
            )
        assertEquals(forwardCompat, decodeUserPresetsJson(encodeUserPresetsJson(forwardCompat)))

        val state =
            MapleState(
                values =
                    mapOf(
                        "exposure" to 0.75f,
                        "contrast" to 0f,
                        "temperature" to 5500f,
                        "_shot_temperature" to 5500f,
                        "_raw" to 1f,
                        "wb_algorithm_version" to 2f,
                        "wb_sample_x" to 0.42f,
                        "wb_sample_y" to 0.58f,
                        "capture_sharpening_radius" to 1.2f,
                    ),
                document =
                    app.justmaple.aperture.data.XmpDocument()
                        .withAttribute("papp:FilmLook", "kodak_portra_400")
                        .withAttribute("crs:ConvertToGrayscale", "True")
                        .withAttribute("papp:Profile", "Neutral"),
            )
        assertEquals(mapOf("exposure" to 0.75f), state.savablePresetFields())
        assertEquals(
            mapOf(
                "papp:FilmLook" to "kodak_portra_400",
                "crs:ConvertToGrayscale" to "True",
                "papp:Profile" to "Neutral",
            ),
            state.savablePresetAttributes(),
        )
        assertTrue(state.isPresetActive(lookOnly.first()))
        assertFalse(MapleState().isPresetActive(lookOnly.first()))
        assertEquals(6, vectorscopeTargetStops.size)
    }

    @Test
    fun toneCurveZoneAndRelativeDragMappingMatchCoreParametricSplits() {
        // Default splits (25, 50, 75) on the core's logarithmic axis map to ~0.01125, 0.045, 0.18
        assertEquals(0.01125f, parametricAxisToAuthoringX(25f), 1e-4f)
        assertEquals(0.045f, parametricAxisToAuthoringX(50f), 1e-4f)
        assertEquals(0.18f, parametricAxisToAuthoringX(75f), 1e-4f)

        assertEquals("parametric_shadows", toneCurveZoneFieldForX(0.005f))
        assertEquals("parametric_darks", toneCurveZoneFieldForX(0.025f))
        assertEquals("parametric_lights", toneCurveZoneFieldForX(0.10f))
        assertEquals("parametric_highlights", toneCurveZoneFieldForX(0.50f))

        // Relative drag from starting slider value: no jump at startNy == currentNy
        assertEquals(35f, toneCurveValueForDrag(startValue = 35f, startNy = 0.5f, currentNy = 0.5f), 1e-4f)
        // Dragging up (smaller ny) increases value; dragging down decreases value
        assertTrue(toneCurveValueForDrag(startValue = 0f, startNy = 0.5f, currentNy = 0.25f) > 0f)
        assertTrue(toneCurveValueForDrag(startValue = 0f, startNy = 0.5f, currentNy = 0.75f) < 0f)
    }
}
