package app.justmaple.aperture

import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary

// Sequential cache-policy tests inspect paths after a completed, closed read.
internal suspend fun PhotoLibrary.thumbnailPath(photo: Photo, edge: Int = 512) =
    withThumbnail(photo, edge) { file, _ -> checkNotNull(file) }
