package app.justmaple.aperture.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SessionValuesTest {
    /** Every metadata key native `values()` writes (`native/src/lib.rs`) reaches the editor state. */
    @Test
    fun theSessionMetadataNativeReportsReachesTheState() {
        val native =
            JSONObject()
                .put("exposure", .5)
                .put("temperature", 5200)
                .put("tint", 3)
                .put("_shot_temperature", 5100)
                .put("_shot_tint", 2)
                .put("_raw", 1)
                .put("_uncropped_aspect", 1.5)
                .put("_aspect", 1.25)
                .put("_orientation", 6)
        val values = sessionValues(native.toString())
        for (key in native.keys()) assertEquals(key, native.getDouble(key).toFloat(), values.getValue(key))
    }
}
