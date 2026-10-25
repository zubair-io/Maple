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
    val previewOrder: List<Photo>? = null,
    val selected: Photo? = null,
    val mode: PhotoMode = PhotoMode.Browse,
    val document: XmpDocument = XmpDocument(),
    val values: Map<String, Float> = emptyMap(),
    val loading: Boolean = false,
    val documentLoaded: Boolean = false,
    val rendering: Boolean = false,
    val saving: Boolean = false,
    val dirty: Boolean = false,
    val error: String? = null,
    val canResetRawOnlySliders: Boolean = false,
    val canUndo: Boolean = false,
    val canRedo: Boolean = false,
    val showFilmstrip: Boolean = true,
    val comparingBefore: Boolean = false,
    val nativeSourceSize: NativeImageSize? = null,
    val nativeImageSize: NativeImageSize? = null,
    val nativeDetail: NativeDetailFrame? = null,
    val nativeDetailBusy: Boolean = false,
    val nativeDimensionsLoading: Boolean = false,
    val nativeDetailError: String? = null,
    val nativeSurfaceRevision: Int = 0,
    val cropToolActive: Boolean = false,
    val cropAspect: app.justmaple.aperture.ui.CropAspectId = app.justmaple.aperture.ui.CropAspectId.Free,
    val cropAspectSwapped: Boolean = false,
    val autoWhiteBalanceInFlight: Boolean = false,
    val userPresets: List<app.justmaple.aperture.ui.BuiltInPreset> = emptyList(),
    val cloudSigningIn: Boolean = false,
    val cloudConnectionsVersion: Int = 0,
) {
    val navigationPhotos: List<Photo> get() = previewOrder ?: photos

    val canChangeMetadata: Boolean
        get() = selected != null && documentLoaded && !loading && !rendering

    val canEdit: Boolean
        get() = mode == PhotoMode.Edit && canChangeMetadata && values.isNotEmpty()

    val hasActiveEdits: Boolean
        get() =
            values.any { (name, v) ->
                val spec = app.justmaple.aperture.generated.AdjustmentFields.byName[name]
                if (spec == null) false
                else {
                    val baseline =
                        when (name) {
                            "temperature" -> values["_shot_temperature"] ?: spec.initial
                            "tint" -> values["_shot_tint"] ?: spec.initial
                            else -> spec.initial
                        }
                    kotlin.math.abs(v - baseline) > 1e-4f
                }
            } ||
                document.attribute("papp:Profile") == "Neutral" ||
                document.attribute("papp:Look") == "Neutral" ||
                document.attribute("crs:ConvertToGrayscale")?.let {
                    it == "1" || it.equals("True", ignoreCase = true)
                } == true ||
                !document.attribute("papp:FilmLook").isNullOrEmpty() ||
                document.attribute("crs:HasCrop")?.equals("True", ignoreCase = true) == true
}

/** Breadcrumbs come from actual provider listings; document IDs can be opaque. */
internal fun MapleState.trailTo(folder: Folder, ancestors: List<Folder>?): List<Folder> {
    val known = folderTrail.indexOfFirst { it.uri == folder.uri }
    if (ancestors == null && known >= 0) return folderTrail.take(known + 1)
    val parent = ancestors ?: if (folders.any { it.uri == folder.uri }) folderTrail else emptyList()
    return parent + folder
}

internal fun MapleState.failed(failure: Throwable, operation: String): MapleState =
    copy(
        error = failure.operationMessage(operation),
        canResetRawOnlySliders = false,
        loading = false,
        rendering = false,
        saving = false,
    )

/** A background save that failed leaves the preview exactly as it was: only the save state changes. */
internal fun MapleState.saveFailed(failure: Throwable): MapleState =
    copy(error = failure.operationMessage("Could not save edits"), canResetRawOnlySliders = false, saving = false)
