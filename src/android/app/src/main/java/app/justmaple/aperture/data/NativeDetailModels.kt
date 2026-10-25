package app.justmaple.aperture.data

import android.graphics.Bitmap
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

data class NativeImageSize(val width: Int, val height: Int) {
    init { require(width > 0 && height > 0) }
    companion object {
        fun unpack(value: Long) = NativeImageSize((value ushr 32).toInt(), value.toInt())
    }
}

data class NativeRegion(val x: Int, val y: Int, val width: Int, val height: Int) {
    fun contains(other: NativeRegion) = x <= other.x && y <= other.y &&
        x + width >= other.x + other.width && y + height >= other.y + other.height

    fun withPanMargin(size: NativeImageSize): NativeRegion {
        val margin = min(512, max(width, height) / 4)
        val left = max(0, x - margin / 2)
        val top = max(0, y - margin / 2)
        val right = min(size.width, x + width + margin / 2)
        val bottom = min(size.height, y + height + margin / 2)
        return NativeRegion(left, top, right - left, bottom - top)
    }
}

data class NativeDetailRequest(
    val photo: Photo,
    val xml: String,
    val region: NativeRegion,
    val generation: Int,
    val editing: Boolean,
)

class NativeDetailFrame(
    val photoKey: String,
    val document: XmpDocument,
    val region: NativeRegion,
    val bitmap: Bitmap,
) : java.io.Closeable {
    private val ownership = Any()
    private var published = true
    private var readers = 0

    /** A composed image keeps its pixels until that image leaves composition. */
    fun retain(): java.io.Closeable? = synchronized(ownership) {
        if (bitmap.isRecycled) return@synchronized null
        readers++
        var released = false
        java.io.Closeable {
            synchronized(ownership) {
                if (!released) {
                    released = true
                    readers--
                    disposeIfUnused()
                }
            }
        }
    }

    override fun close() = synchronized(ownership) {
        published = false
        disposeIfUnused()
    }

    private fun disposeIfUnused() {
        if (!published && readers == 0 && !bitmap.isRecycled) bitmap.recycle()
    }
}

/** Source-pixel window of a centre-anchored canvas. No preview texture dimensions enter it. */
fun nativeViewportRegion(size: NativeImageSize, viewportWidth: Float, viewportHeight: Float,
    pixelScale: Float, panX: Float, panY: Float): NativeRegion? {
    if (!pixelScale.isFinite() || pixelScale < 1f || viewportWidth <= 0f || viewportHeight <= 0f) return null
    val left = viewportWidth / 2f + panX - size.width * pixelScale / 2f
    val top = viewportHeight / 2f + panY - size.height * pixelScale / 2f
    val x = floor(-left / pixelScale).toInt().coerceIn(0, size.width)
    val y = floor(-top / pixelScale).toInt().coerceIn(0, size.height)
    val right = ceil((viewportWidth - left) / pixelScale).toInt().coerceIn(x, size.width)
    val bottom = ceil((viewportHeight - top) / pixelScale).toInt().coerceIn(y, size.height)
    return if (right > x && bottom > y) NativeRegion(x, y, right - x, bottom - y) else null
}
