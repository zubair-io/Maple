package app.justmaple.aperture.data

import android.graphics.Bitmap
import android.view.Surface

object NativeBridge {
    init {
        System.loadLibrary("maple_jni")
    }

    external fun createRenderer(): Long

    external fun closeRenderer(renderer: Long)

    external fun open(path: String, xml: String, edge: Int, renderer: Long): Long

    external fun close(handle: Long)

    external fun values(handle: Long): String

    external fun setField(handle: Long, index: Int, value: Float)

    external fun setModel(handle: Long, xml: String)

    external fun rasterCompatible(xml: String): Boolean

    external fun attach(
        handle: Long,
        surface: Surface?,
        width: Int,
        height: Int,
        wideColor: Boolean,
    )

    external fun render(handle: Long)

    external fun thumbnail(path: String, destination: String, xml: String, edge: Int)

    external fun export(path: String, xml: String, destination: String)

    external fun stageBitmap(bitmap: Bitmap, destination: String, profile: FloatArray)
}
