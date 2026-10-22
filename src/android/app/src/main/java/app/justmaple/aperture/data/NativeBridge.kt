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

    external fun parametricCurve(xml: String): String

    external fun scopePixels(pixels: IntArray, width: Int, height: Int): String

    external fun createAutoWhiteBalance(handle: Long, xml: String): Long
    external fun runAutoWhiteBalance(work: Long): String
    external fun closeAutoWhiteBalance(work: Long)

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

    external fun createCancellation(): Long

    external fun setCancellation(flag: Long, value: Boolean)

    external fun closeCancellation(flag: Long)

    external fun render(handle: Long, flag: Long): Boolean

    external fun createPreparation(handle: Long): Long

    external fun runPreparation(work: Long, flag: Long): Boolean

    external fun applyPreparation(handle: Long, work: Long, flag: Long): Boolean

    external fun closePreparation(work: Long)

    external fun thumbnail(path: String, destination: String, xml: String, edge: Int)

    external fun sharedDerivative(path: String, destination: String, xml: String, preview: Boolean)

    external fun cacheValid(fd: Int, edge: Int, format: String): Boolean

    external fun cachePng(fd: Int, destination: String)

    external fun export(path: String, xml: String, destination: String)

    external fun exportConfigured(path: String, xml: String, destination: String,
        format: String, quality: Int, maxEdge: Int, displayP3: Boolean)

    external fun stageBitmap(bitmap: Bitmap, destination: String, profile: FloatArray)
}
