package app.justmaple.aperture.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.justmaple.aperture.data.parseExifAttributes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ExifAndExportOptionsTest {
    @get:Rule val compose = createComposeRule()

    private fun sampleAttrs() =
        mapOf(
            "Make" to "Canon",
            "Model" to "Canon EOS R5",
            "LensModel" to "RF24-105mm F4 L IS USM",
            "FocalLength" to "50/1",
            "FNumber" to "28/10",
            "ExposureTime" to "1/250",
            "Iso" to "100",
            "ImageWidth" to "8192",
            "ImageLength" to "5464",
            "DateTimeOriginal" to "2024:05:06 12:34:56",
        )

    @Test
    fun parseExifFormatsFieldsDeterministically() {
        val exif = parseExifAttributes(sampleAttrs())
        assertTrue(exif.hasAnyExif)
        assertEquals("Canon EOS R5", exif.cameraSummary)
        assertEquals("RF24-105mm F4 L IS USM", exif.lensModel)
        assertEquals("50 mm", exif.focalLength)
        assertEquals("ƒ/2.8", exif.aperture)
        assertEquals("1/250 s", exif.shutterSpeed)
        assertEquals("100", exif.iso)
        assertEquals("8192 × 5464", exif.dimensions)
        assertEquals("2024-05-06 12:34:56", exif.captureDate)
    }

    @Test
    fun parseExifHandlesMissingAndMessyValues() {
        val empty = parseExifAttributes(emptyMap())
        assertFalse(empty.hasAnyExif)
        assertNull(empty.cameraSummary)

        val makeOnly = parseExifAttributes(mapOf("Make" to "Sony"))
        assertTrue(makeOnly.hasAnyExif)
        assertEquals("Sony", makeOnly.cameraSummary)

        val photographicSensitivity =
            parseExifAttributes(mapOf("Iso" to "200, 400", "ExposureTime" to "2/1"))
        assertEquals("200", photographicSensitivity.iso)
        assertEquals("2 s", photographicSensitivity.shutterSpeed)

        val badNumbers = parseExifAttributes(mapOf("FocalLength" to "n/a", "FNumber" to "5/0"))
        assertNull(badNumbers.focalLength)
        assertNull(badNumbers.aperture)

        val partialDimensions = parseExifAttributes(mapOf("ImageWidth" to "6000"))
        assertNull(partialDimensions.dimensions)
    }

    @Test
    fun suggestedFileNameKeepsStemAndUsesFormatExtension() {
        assertEquals("photo-Maple.jpg", ExportOptions().suggestedFileName(null))
        assertEquals("dsc-Maple.jpg", ExportOptions().suggestedFileName("dsc.dng"))
        assertEquals(
            "dsc-Maple.png",
            ExportOptions(format = ExportFormat.PNG).suggestedFileName("dsc.dng"),
        )
        assertEquals(
            "dsc-Maple.webp",
            ExportOptions(format = ExportFormat.WEBP).suggestedFileName("dsc.dng"),
        )
        assertEquals("photo-Maple.jpg", ExportOptions().suggestedFileName(""))
    }

    @Test
    fun dialogExposesFormatsQualityAndConfirmsSelection() {
        var confirmed: ExportOptions? = null
        var dismissed = false
        compose.setContent {
            ExportOptionsDialog(
                initial = ExportOptions(),
                onConfirm = { confirmed = it },
                onDismiss = { dismissed = true },
            )
        }
        compose.onNodeWithTag("export-options-dialog").assertIsDisplayed()
        compose.onNodeWithTag("export-format-JPEG").assertIsSelected()
        compose.onNodeWithTag("export-format-PNG").assertIsNotSelected()
        compose.onNodeWithTag("export-quality-slider").assertIsDisplayed()

        compose.onNodeWithTag("export-format-PNG").performClick()
        compose.onNodeWithTag("export-format-PNG").assertIsSelected()
        compose.onNodeWithTag("export-quality-slider").assertDoesNotExist()

        compose.onNodeWithTag("export-max-edge-2048").performClick()
        compose.onNodeWithText("Export").performClick()
        compose.runOnIdle {
            assertEquals(ExportFormat.PNG, confirmed?.format)
            assertEquals(2048, confirmed?.maxEdge)
            assertFalse(dismissed)
        }
    }

    @Test
    fun dialogCancelDismissesWithoutConfirming() {
        var confirmed: ExportOptions? = null
        var dismissed = false
        compose.setContent {
            ExportOptionsDialog(
                initial = ExportOptions(),
                onConfirm = { confirmed = it },
                onDismiss = { dismissed = true },
            )
        }
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle {
            assertNull(confirmed)
            assertTrue(dismissed)
        }
    }
}
