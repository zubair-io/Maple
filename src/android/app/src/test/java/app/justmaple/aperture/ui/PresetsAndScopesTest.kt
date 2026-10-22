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
    fun parametricCurveEvaluatesIdentityAtZeroAndBendsInZones() {
        for (x in listOf(0f, 0.25f, 0.5f, 0.75f, 1f)) {
            assertEquals(x, evaluateParametricCurveAt(x), 1e-4f)
        }
        val liftedShadows = evaluateParametricCurveAt(0.2f, shadows = 60f)
        assertTrue("Positive shadows should lift dark-zone curve", liftedShadows > 0.2f)

        val pulledHighlights = evaluateParametricCurveAt(0.8f, highlights = -60f)
        assertTrue("Negative highlights should lower bright-zone curve", pulledHighlights < 0.8f)

        assertEquals(0f, evaluateParametricCurveAt(0f, shadows = 100f, highlights = 100f), 1e-5f)
        assertEquals(1f, evaluateParametricCurveAt(1f, shadows = -100f, highlights = -100f), 1e-5f)
    }

    @Test
    fun rgbHistogramReductionProducesWaveformAndParadeColumns() {
        val width = 8
        val height = 4
        // Left half pure red (255, 0, 0), right half pure blue (0, 0, 255)
        val pixels =
            IntArray(width * height) { idx ->
                val x = idx % width
                if (x < width / 2) 0xFFFF0000.toInt() else 0xFF0000FF.toInt()
            }
        val sample = RgbHistogram.fromArgbPixels(pixels, width, height)
        assertEquals(3, sample.channels.size)
        assertEquals(RgbHistogram.BINS, sample.channels[0].size)
        assertEquals(RgbHistogram.COLUMNS, sample.waveformLuma.size)
        assertEquals(RgbHistogram.COLUMNS, sample.paradeR.size)
        assertEquals(RgbHistogram.COLUMNS, sample.paradeG.size)
        assertEquals(RgbHistogram.COLUMNS, sample.paradeB.size)

        // First column is pure red -> paradeR == 1f, paradeB == 0f
        assertEquals(1f, sample.paradeR.first(), 1e-3f)
        assertEquals(0f, sample.paradeB.first(), 1e-3f)
        // Last column is pure blue -> paradeR == 0f, paradeB == 1f
        assertEquals(0f, sample.paradeR.last(), 1e-3f)
        assertEquals(1f, sample.paradeB.last(), 1e-3f)
        // Rec.709 luma of pure red (0.2126) > pure blue (0.0722)
        assertTrue(sample.waveformLuma.first() > sample.waveformLuma.last())
    }

    @Test
    fun histogramChipCyclesThroughHistogramWaveformAndParadeOnTap() {
        val pixels = IntArray(16 * 8) { 0xFF80A0C0.toInt() }
        val sample = RgbHistogram.fromArgbPixels(pixels, 16, 8)
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
