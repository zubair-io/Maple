package app.justmaple.aperture.cloud

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudPhotoIdentityTest {
    @Test
    fun searchRetainsServerAssetIdentityForPairOperations() {
        val photo = CloudSearchWire.photo("server", JSONObject("""{
            "id":"raw-id", "address":"lib:photo.dng", "abs_path":"/photos/photo.dng",
            "filename":"photo.dng", "size":2048, "mtime":1700000000000
        }"""))!!
        val getter = photo.javaClass.methods.find { it.name == "getAssetId" }
        assertNotNull("Cloud photos must retain the server asset id", getter)
        assertEquals("raw-id", getter!!.invoke(photo))
    }
}
