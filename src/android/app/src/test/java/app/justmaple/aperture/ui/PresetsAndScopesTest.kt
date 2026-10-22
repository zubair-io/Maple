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
    fun histogramChipCyclesThroughHistogramWaveformAndParadeOnTap() {
        val density = listOf(1f, 0f, 0f, 1f)
        val sample = RgbHistogram(List(3) { listOf(0.5f, 1f) }, 2, 2,
            density, density, density, density)
        compose.setContent { HistogramChip(Result.success(sample)) }

        val chip = compose.onNodeWithTag("editor-scopes-chip")
        chip.assertIsDisplayed()

        // Tap 1 -> Waveform
        chip.performClick()
        compose.onNodeWithText("WAVEFORM").assertIsDisplayed()

        // Tap 2 -> RGB Parade
        chip.performClick()
        compose.onNodeWithText("RGB PARADE").assertIsDisplayed()

        // Tap 3 -> back to Histogram
        chip.performClick()
        compose.onNodeWithText("RGB PARADE").assertDoesNotExist()
    }
}
