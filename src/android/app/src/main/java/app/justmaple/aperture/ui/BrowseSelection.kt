package app.justmaple.aperture.ui

import app.justmaple.aperture.data.Photo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class BrowseSelectionState(val active: Boolean = false, val ids: Set<String> = emptySet()) {
    fun toggle(id: String) = copy(active = true, ids = if (id in ids) ids - id else ids + id)
    fun all(photos: List<Photo>) = copy(active = true, ids = photos.map { it.uri.toString() }.toSet())
    fun clear() = copy(ids = emptySet())
    fun retain(photos: List<Photo>) = copy(ids = ids.intersect(photos.map { it.uri.toString() }.toSet()))
}

class BrowseSelection {
    private val mutable = MutableStateFlow(BrowseSelectionState())
    val state = mutable.asStateFlow()
    private var folder: String? = null

    fun toggle(photo: Photo) = mutable.update { it.toggle(photo.uri.toString()) }
    fun selectAll(photos: List<Photo>) = mutable.update { it.all(photos) }
    fun clear() = mutable.update { it.clear() }
    fun cancel() { mutable.value = BrowseSelectionState() }
    fun reconcile(scope: String?, photos: List<Photo>) {
        mutable.update { if (folder != scope) BrowseSelectionState() else it.retain(photos) }
        folder = scope
    }
}
