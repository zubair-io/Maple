package app.justmaple.aperture.data

import android.net.Uri
import app.justmaple.aperture.cloud.CloudLibrary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** What a sidecar looked like in its folder listing, plus how often this app saved it; equal stamps mean an unchanged file. */
data class SidecarStamp(val document: Uri?, val size: Long, val modified: Long, val savedHere: Int)

/** A null [loaded] is an unreadable sidecar. */
class ScannedSidecar(val stamp: SidecarStamp?, val loaded: LoadedSidecar?)

/** Unreadable marks stay unknown. */
internal suspend fun PhotoLibrary.scanSidecars(
    photos: List<Photo>,
    known: (Photo) -> SidecarStamp?,
    record: (Photo, ScannedSidecar) -> Unit,
) =
    withContext(Dispatchers.IO) {
        for ((parent, siblings) in photos.groupBy { it.parent }) {
            currentCoroutineContext().ensureActive()
            val entries =
                if (parent != null && siblings.none { CloudLibrary.isCloud(it.uri) })
                    PhotoLibrary.io.shared {
                        currentCoroutineContext().ensureActive()
                        local.list(parent, fresh = true)
                    }
                else null
            for (photo in siblings) {
                currentCoroutineContext().ensureActive()
                val stamp = entries?.let { saf.stamp(photo, it, savedHere(photo), System.currentTimeMillis()) }
                if (stamp != null && stamp == known(photo)) continue
                try {
                    val xml = readingSidecar(photo) {
                        currentCoroutineContext().ensureActive()
                        readSidecar(photo)
                    }
                    currentCoroutineContext().ensureActive()
                    record(photo, ScannedSidecar(stamp, LoadedSidecar(XmpDocument(xml ?: XmpDocument.EMPTY), xml)))
                } catch (failure: Exception) {
                    if (failure is kotlinx.coroutines.CancellationException) throw failure
                    record(photo, ScannedSidecar(null, null))
                }
            }
        }
    }
