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
    val canUndo: Boolean = false,
    val canRedo: Boolean = false,
    val showFilmstrip: Boolean = true,
    val cloudSigningIn: Boolean = false,
    val cloudConnectionsVersion: Int = 0,
)
