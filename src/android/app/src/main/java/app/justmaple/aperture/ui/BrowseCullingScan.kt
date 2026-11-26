package app.justmaple.aperture.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.SidecarStamp
import app.justmaple.aperture.data.scanSidecars
import app.justmaple.aperture.data.XmpDocument
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Badge marks per photo, kept across grid mounts. */
internal class BrowseCullingScan(private val library: PhotoLibrary) {
    private class Known(val stamp: SidecarStamp?, val culling: PhotoCulling)

    private val known = ConcurrentHashMap<String, Known>()

    suspend fun scan(photos: List<Photo>): Map<String, PhotoCulling> {
        known.keys.retainAll(photos.mapTo(HashSet()) { it.uri.toString() })
        library.scanSidecars(photos, { known[it.uri.toString()]?.stamp }) { photo, scanned ->
            known[photo.uri.toString()] =
                Known(scanned.stamp, scanned.loaded?.let { cullingOf(it.document) } ?: PhotoCulling())
        }
        return photos.associate { it.uri.toString() to (known[it.uri.toString()]?.culling ?: PhotoCulling()) }
    }
}

/** The open photo's marks come from its live document; every other photo's from the sidecar scan. */
@Composable
internal fun rememberBrowseCulling(
    scan: BrowseCullingScan,
    photos: List<Photo>,
    selected: Photo?,
    document: XmpDocument,
    documentLoaded: Boolean,
): Map<String, PhotoCulling> {
    var scanned by remember { mutableStateOf(emptyMap<String, PhotoCulling>()) }
    LaunchedEffect(photos, selected?.uri) { scanned = withContext(Dispatchers.IO) { scan.scan(photos) } }
    return remember(scanned, selected?.uri, document, documentLoaded) {
        val key = selected?.uri?.toString()
        if (documentLoaded && key != null && key in scanned) scanned + (key to cullingOf(document)) else scanned
    }
}
