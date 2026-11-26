package app.justmaple.aperture.data

import android.graphics.Bitmap
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Loads grid tiles; only the 512 px ones are remembered. */
internal class ThumbnailTiles(
    val cache: ThumbnailBitmapCache,
    private val decode: suspend (Photo, Int) -> Bitmap?,
) {
    fun cached(photo: Photo, revision: String?): Bitmap? = cache[key(photo, TILE_EDGE, revision)]

    suspend fun load(photo: Photo, edge: Int, revision: String?): Bitmap? {
        val bitmap = decode(photo, edge) ?: return null
        currentCoroutineContext().ensureActive()
        if (edge == TILE_EDGE) cache.put(key(photo, edge, revision), bitmap)
        return bitmap
    }

    private fun key(photo: Photo, edge: Int, revision: String?) =
        TileKey(photo.uri.toString(), photo.key, edge, revision)

    companion object {
        const val TILE_EDGE = 512
    }
}
