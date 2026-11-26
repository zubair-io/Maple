package app.justmaple.aperture.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** #6042: the name rule mirrors `library/raw-jpeg-stack.ts` and Apple's `RawJpegPairingTests`. */
class RawJpegPairingTest {
    @Test
    fun aSameStemRawAndJpegPair() {
        assertEquals(
            mapOf("IMG_1.CR3" to "IMG_1.JPG"),
            RawJpegPairing.pairs(listOf("IMG_1.CR3", "IMG_1.JPG", "IMG_2.CR3")),
        )
    }

    @Test
    fun theStemIsCaseFoldedAndTheJpegExtensionMayBeEitherSpelling() {
        assertEquals(
            mapOf("img_1.dng" to "IMG_1.JPEG"),
            RawJpegPairing.pairs(listOf("img_1.dng", "IMG_1.JPEG")),
        )
    }

    @Test
    fun differentUnicodeFormsOfOneStemStayIndependentBecauseTheirSidecarsDiffer() {
        assertTrue(RawJpegPairing.pairs(listOf("Cafe\u0301.CR3", "Caf\u00e9.jpg")).isEmpty())
    }

    @Test
    fun twoJpegsOnOneStemStayIndependent() {
        assertTrue(RawJpegPairing.pairs(listOf("IMG_1.CR3", "IMG_1.jpg", "IMG_1.JPEG")).isEmpty())
    }

    @Test
    fun twoRawsOnOneStemStayIndependent() {
        assertTrue(RawJpegPairing.pairs(listOf("IMG_1.CR3", "IMG_1.DNG", "IMG_1.jpg")).isEmpty())
    }

    @Test
    fun twoFilesWithTheSameNameAreTwoFilesOnTheStem() {
        assertTrue(RawJpegPairing.pairs(listOf("IMG_1.CR3", "IMG_1.CR3", "IMG_1.jpg")).isEmpty())
        assertTrue(RawJpegPairing.pairs(listOf("IMG_1.CR3", "IMG_1.jpg", "IMG_1.jpg")).isEmpty())
    }

    @Test
    fun aRawBesideAnyOtherRasterStaysIndependent() {
        for (raster in listOf("HEIC", "heif", "png", "webp", "tif", "TIFF", "avif"))
            assertTrue(raster, RawJpegPairing.pairs(listOf("IMG_1.CR3", "IMG_1.$raster")).isEmpty())
    }

    @Test
    fun aTiffIsARasterNotTheRawOfAPair() {
        assertTrue(RawJpegPairing.pairs(listOf("IMG_1.TIF", "IMG_1.jpg")).isEmpty())
        assertTrue(RawJpegPairing.pairs(listOf("IMG_1.tiff", "IMG_1.jpeg")).isEmpty())
    }

    @Test
    fun everyRawTypeTheServerPairsIsARawHere() {
        val server =
            setOf(
                "cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2", "pef", "srw", "x3f", "3fr",
                "mef", "erf", "mrw", "raw", "fff",
            )

        assertEquals(server, RawJpegPairing.RAW_EXTENSIONS)
        for (raw in server)
            assertEquals(
                mapOf("a.${raw.uppercase()}" to "A.jpg"),
                RawJpegPairing.pairs(listOf("a.${raw.uppercase()}", "A.jpg")),
            )
    }

    @Test
    fun onlyTheLastExtensionIsRemovedFromTheStem() {
        assertEquals(
            mapOf("trip.day1.CR3" to "trip.day1.jpg"),
            RawJpegPairing.pairs(listOf("trip.day1.CR3", "trip.day1.jpg", "trip.CR3", "trip.day1.edit.jpg")),
        )
    }

    @Test
    fun aNameThatIsOnlyAnExtensionHasNone() {
        assertEquals("", RawJpegPairing.extension(".jpg"))
        assertEquals(".jpg", RawJpegPairing.stem(".jpg"))
        assertEquals("", RawJpegPairing.extension("IMG_1."))
        assertEquals("", RawJpegPairing.extension("IMG_1"))
        assertTrue(RawJpegPairing.pairs(listOf(".CR3", ".jpg")).isEmpty())
    }

    @Test
    fun eachStemPairsOnItsOwn() {
        assertEquals(
            mapOf("IMG_1.CR3" to "IMG_1.JPG", "IMG_2.NEF" to "img_2.jpeg"),
            RawJpegPairing.pairs(listOf("IMG_1.CR3", "IMG_1.JPG", "IMG_2.NEF", "img_2.jpeg", "IMG_3.JPG")),
        )
    }
}
