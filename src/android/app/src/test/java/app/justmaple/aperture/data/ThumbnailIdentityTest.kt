package app.justmaple.aperture.data

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ThumbnailIdentityTest {
    @Test
    fun streamedHashesKeepExistingUtf8IdentitiesAcrossBufferAndPartBoundaries() {
        val prefix = "v25:photo #😀:512:"
        val sidecar = "<!--" + "a".repeat(4 * 1024 * 1024) + "--> café 中 😀"
        fun expected(value: String) =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") {
                "%02x".format(it)
            }
        assertEquals(expected(prefix + sidecar), PhotoLibrary.digestParts(prefix, sidecar))
        assertEquals(expected(sidecar), PhotoLibrary.digest(sidecar))
        assertEquals(
            expected("x".repeat(4095) + "😀"),
            PhotoLibrary.digestParts("x".repeat(4095) + "\uD83D", "\uDE00"),
        )
    }
}
