package app.justmaple.aperture.data

/** The two sidecar operations the view model's save/reload paths depend on (#4765). */
interface SidecarStore {
    suspend fun loadSidecar(photo: Photo): LoadedSidecar

    suspend fun save(photo: Photo, document: XmpDocument, baseline: String?): LoadedSidecar
}
