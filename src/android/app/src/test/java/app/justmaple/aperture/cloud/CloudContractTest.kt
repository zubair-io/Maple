package app.justmaple.aperture.cloud

import android.net.Uri
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudContractTest {
    @Test
    fun serverOriginAcceptsDomainsAndRejectsCredentialOrPathInjection() {
        assertEquals("https://photos.example.com", CloudLogin.origin(" Photos.Example.com/ "))
        assertEquals(
            "https://photos.example.com:8443",
            CloudLogin.origin("https://photos.example.com:8443"),
        )
        for (invalid in
            listOf(
                "",
                "https://user:secret@example.com",
                "https://example.com/sub",
                "https://example.com?host=other",
                "https://example.com#x",
                "http://example.com",
                "http://[::1]",
                "file:///photos",
            )) {
            assertThrows("Unexpected accepted origin: $invalid", Exception::class.java) {
                CloudLogin.origin(invalid)
            }
        }
    }

    @Test
    fun pkceMatchesRfc7636AndCallbacksAreBoundToPendingState() {
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            CloudLogin.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        )
        val login = CloudLogin.create("photos.example.com")
        val callback =
            Uri.parse("maple-app://auth-success")
                .buildUpon()
                .appendQueryParameter("state", login.state)
                .appendQueryParameter("code", "one-time-code")
                .build()
        assertEquals("one-time-code", login.validateCallback(callback))
        for (invalid in
            listOf(
                Uri.parse("maple-app://auth-success?code=one-time-code&state=wrong"),
                callback.buildUpon().appendQueryParameter("state", login.state).build(),
                callback.buildUpon().authority("other").build(),
                callback.buildUpon().appendPath("other").build(),
                callback.buildUpon().appendQueryParameter("code", "second").build(),
            )) assertThrows(IllegalArgumentException::class.java) {
            login.validateCallback(invalid)
        }
        assertThrows(IllegalArgumentException::class.java) {
            login.copy(started = 0).validateCallback(callback)
        }
    }

    @Test
    fun cloudMediaAddressesEncodeEachSegmentAndRejectTraversal() {
        val uri =
            Uri.parse("maple-cloud://server")
                .buildUpon()
                .appendQueryParameter("address", "photos:2026/a #😀.dng")
                .build()
        assertEquals(
            "/api/image/photos/2026/a%20%23%F0%9F%98%80.dng",
            CloudLibrary.mediaPath("image", uri),
        )
        assertThrows(IllegalArgumentException::class.java) {
            CloudLibrary.mediaPath(
                "image",
                uri.buildUpon()
                    .clearQuery()
                    .appendQueryParameter("address", "photos:../secret")
                    .build(),
            )
        }
    }
}
