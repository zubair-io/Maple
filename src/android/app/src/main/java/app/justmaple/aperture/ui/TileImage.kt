package app.justmaple.aperture.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import app.justmaple.aperture.cloud.CloudDerivativePending
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.ThumbnailTiles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

@Stable
internal class TileImage(initial: ImageBitmap?) {
    var image by mutableStateOf(initial)
    var failed by mutableStateOf(false)
    private var remembered = initial != null

    fun loaded(next: ImageBitmap?) {
        remembered = false
        image = next
        failed = next == null
    }

    // A remembered bitmap only fills the cell while the load runs; today's failure display wins once it fails.
    fun failedToLoad() {
        if (remembered) image = null
        remembered = false
        failed = true
    }
}

@Composable
internal fun rememberTileImage(
    photo: Photo,
    tiles: ThumbnailTiles,
    fit: Boolean,
    revision: String?,
): TileImage {
    val tile =
        remember(photo.key) {
            TileImage(if (fit) null else tiles.cached(photo, revision)?.asImageBitmap())
        }
    LaunchedEffect(photo.key, revision, fit) {
        suspend fun load(edge: Int): ImageBitmap? = tiles.load(photo, edge, revision)?.asImageBitmap()
        while (currentCoroutineContext().isActive) {
            try {
                tile.loaded(load(if (fit) 2048 else ThumbnailTiles.TILE_EDGE))
                break
            } catch (pending: CloudDerivativePending) {
                if (tile.image == null && fit) {
                    try {
                        tile.loaded(load(ThumbnailTiles.TILE_EDGE))
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        tile.failedToLoad()
                    }
                }
                delay(pending.retryMillis)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                tile.failedToLoad()
                break
            }
        }
    }
    return tile
}
