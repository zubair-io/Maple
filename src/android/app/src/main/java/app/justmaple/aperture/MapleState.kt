package app.justmaple.aperture

import app.justmaple.aperture.data.*

enum class PhotoMode {
    Browse,
    Preview,
    Edit,
}

data class MapleState(
    val sources: List<Folder> = emptyList(),
    val folder: Folder? = null,
    val folderTrail: List<Folder> = emptyList(),
    val folders: List<Folder> = emptyList(),
    val photos: List<Photo> = emptyList(),
    val selected: Photo? = null,
    val mode: PhotoMode = PhotoMode.Browse,
    val document: XmpDocument = XmpDocument(),
    val values: Map<String, Float> = emptyMap(),
    val loading: Boolean = false,
    val rendering: Boolean = false,
    val saving: Boolean = false,
    val dirty: Boolean = false,
    val error: String? = null,
    val canResetRawOnlySliders: Boolean = false,
    val canUndo: Boolean = false,
    val canRedo: Boolean = false,
    val showFilmstrip: Boolean = true,
    val cloudSigningIn: Boolean = false,
    val cloudConnectionsVersion: Int = 0,
) {
    val canEdit: Boolean
        get() = mode == PhotoMode.Edit && !loading && !rendering && values.isNotEmpty()
}

/** Breadcrumbs come from actual provider listings; document IDs can be opaque. */
internal fun MapleState.trailTo(folder: Folder, ancestors: List<Folder>?): List<Folder> {
    val known = folderTrail.indexOfFirst { it.uri == folder.uri }
    if (ancestors == null && known >= 0) return folderTrail.take(known + 1)
    val parent = ancestors ?: if (folders.any { it.uri == folder.uri }) folderTrail else emptyList()
    return parent + folder
}
