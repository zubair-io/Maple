package app.justmaple.aperture.data

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.graphics.Bitmap
import android.util.LruCache

/** The identity of one decoded grid tile: a different photo, folder, size or revision is a different key. */
internal data class TileKey(val photoUri: String, val photoKey: String, val edge: Int, val revision: String?)

/**
 * Decoded grid tiles, kept only so a tile that scrolls back in has pixels on its first frame. Every
 * tile still runs its normal load and freshness check and replaces what was cached.
 */
internal class ThumbnailBitmapCache(val maxBytes: Long) {
    private val bitmaps =
        object : LruCache<TileKey, Bitmap>(maxBytes.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()) {
            override fun sizeOf(key: TileKey, value: Bitmap) = value.byteCount
        }

    val bytes: Int
        get() = bitmaps.size()

    operator fun get(key: TileKey): Bitmap? = bitmaps[key]

    fun put(key: TileKey, bitmap: Bitmap) {
        bitmaps.put(key, bitmap)
    }

    fun drop(photoUri: String) {
        bitmaps.snapshot().keys.filter { it.photoUri == photoUri }.forEach(bitmaps::remove)
    }

    fun onTrimMemory(level: Int) {
        @Suppress("DEPRECATION")
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) bitmaps.evictAll()
    }

    companion object {
        /** An eighth of the app's memory class. */
        fun forDevice(context: Context): ThumbnailBitmapCache {
            val memoryClassMegabytes =
                (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).memoryClass
            return ThumbnailBitmapCache(memoryClassMegabytes * 1024L * 1024 / 8)
        }
    }
}
