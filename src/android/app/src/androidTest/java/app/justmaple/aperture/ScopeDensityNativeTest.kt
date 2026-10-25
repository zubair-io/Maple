package app.justmaple.aperture

import androidx.test.ext.junit.runners.AndroidJUnit4
import app.justmaple.aperture.data.NativeBridge
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScopeDensityNativeTest {
    @Test
    fun equalMeanColumnsRetainBothClippingExtremesThroughJni() {
        val split = JSONObject(NativeBridge.scopePixels(intArrayOf(0xFF000000.toInt(), 0xFFFFFFFF.toInt()), 1, 2))
        val middle = JSONObject(NativeBridge.scopePixels(intArrayOf(0xFF7F7F7F.toInt(), 0xFF808080.toInt()), 1, 2))
        val bins = split.getInt("bins")
        val columns = split.getInt("columns")
        for (name in listOf("waveformLuma", "paradeR", "paradeG", "paradeB")) {
            val extremes = split.getJSONArray(name)
            val midtones = middle.getJSONArray(name)
            assertEquals(columns * bins, extremes.length())
            assertEquals(1.0, extremes.getDouble(0), 0.0)
            assertEquals(1.0, extremes.getDouble(bins - 1), 0.0)
            assertEquals(0.0, midtones.getDouble(0), 0.0)
            assertEquals(0.0, midtones.getDouble(bins - 1), 0.0)
        }
    }
}
