package app.justmaple.aperture.data

import android.media.ExifInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException

data class PhotoExifMetadata(
    val cameraMake: String? = null,
    val cameraModel: String? = null,
    val lensModel: String? = null,
    val focalLength: String? = null,
    val aperture: String? = null,
    val shutterSpeed: String? = null,
    val iso: String? = null,
    val dimensions: String? = null,
    val captureDate: String? = null,
) {
    val hasAnyExif: Boolean
        get() =
            listOf(
                cameraMake,
                cameraModel,
                lensModel,
                focalLength,
                aperture,
                shutterSpeed,
                iso,
                dimensions,
                captureDate,
            ).any { !it.isNullOrBlank() }

    val cameraSummary: String?
        get() {
            val make = cameraMake?.trim().orEmpty()
            val model = cameraModel?.trim().orEmpty()
            if (make.isEmpty() && model.isEmpty()) return null
            if (make.isNotEmpty() && model.startsWith(make, ignoreCase = true)) return model
            return listOf(make, model).filter { it.isNotEmpty() }.joinToString(" ")
        }
}

private const val LENS_MODEL_TAG = "LensModel"
private const val PHOTOGRAPHIC_SENSITIVITY_TAG = "PhotographicSensitivity"

suspend fun readPhotoExif(library: PhotoLibrary, photo: Photo): PhotoExifMetadata = withContext(Dispatchers.IO) {
    try {
      library.withSourceMetadata(photo) { file ->
        val attrs = mutableMapOf<String, String?>()
        file.inputStream().use { stream ->
            val exif = ExifInterface(stream)
            attrs["Make"] = exif.getAttribute(ExifInterface.TAG_MAKE)
            attrs["Model"] = exif.getAttribute(ExifInterface.TAG_MODEL)
            attrs["LensModel"] = exif.getAttribute(LENS_MODEL_TAG)
            attrs["FocalLength"] = exif.getAttribute(ExifInterface.TAG_FOCAL_LENGTH)
            attrs["FNumber"] = exif.getAttribute(ExifInterface.TAG_F_NUMBER)
            attrs["ExposureTime"] = exif.getAttribute(ExifInterface.TAG_EXPOSURE_TIME)
            attrs["Iso"] =
                exif.getAttribute(ExifInterface.TAG_ISO_SPEED_RATINGS)
                    ?: exif.getAttribute(PHOTOGRAPHIC_SENSITIVITY_TAG)
            attrs["ImageWidth"] = exif.getAttribute(ExifInterface.TAG_IMAGE_WIDTH)
            attrs["ImageLength"] = exif.getAttribute(ExifInterface.TAG_IMAGE_LENGTH)
            attrs["DateTimeOriginal"] = exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
        }
        parseExifAttributes(attrs)
      }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        PhotoExifMetadata()
    }
}

fun parseExifAttributes(attrs: Map<String, String?>): PhotoExifMetadata {
    val make = attrs["Make"]?.trim()?.takeIf { it.isNotEmpty() }
    val model = attrs["Model"]?.trim()?.takeIf { it.isNotEmpty() }
    val lens = attrs["LensModel"]?.trim()?.takeIf { it.isNotEmpty() }
    val focal = parseRational(attrs["FocalLength"])?.let { formatNumber(it) + " mm" }
    val aperture = parseRational(attrs["FNumber"])?.let { "ƒ/" + formatNumber(it) }
    val shutter = formatShutter(attrs["ExposureTime"])
    val iso = attrs["Iso"]?.trim()?.split(Regex("[,\\s]+"))?.firstOrNull()?.takeIf { it.isNotEmpty() }
    val width = attrs["ImageWidth"]?.trim()?.toIntOrNull()
    val height = attrs["ImageLength"]?.trim()?.toIntOrNull()
    val dimensions =
        if (width != null && height != null && width > 0 && height > 0) "$width × $height" else null
    val capture = formatExifDate(attrs["DateTimeOriginal"]?.trim())
    return PhotoExifMetadata(make, model, lens, focal, aperture, shutter, iso, dimensions, capture)
}

private fun parseRational(raw: String?): Double? {
    val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val slash = value.indexOf('/')
    return try {
        if (slash < 0) value.toDouble()
        else {
            val num = value.substring(0, slash).toDouble()
            val den = value.substring(slash + 1).toDouble()
            if (den == 0.0) null else num / den
        }
    } catch (_: NumberFormatException) {
        null
    }
}

private fun formatNumber(value: Double): String {
    val rounded = Math.round(value * 10.0) / 10.0
    return if (rounded == Math.floor(rounded)) rounded.toInt().toString() else rounded.toString()
}

private fun formatShutter(raw: String?): String? {
    val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val seconds = parseRational(value) ?: return value
    if (seconds <= 0) return value
    return if (seconds < 1.0) "1/${Math.round(1.0 / seconds)} s" else "${formatNumber(seconds)} s"
}

private fun formatExifDate(raw: String?): String? {
    if (raw.isNullOrEmpty()) return null
    if (raw.length < 10 || raw[4] != ':' || raw[7] != ':') return raw
    return raw.substring(0, 4) + "-" + raw.substring(5, 7) + "-" + raw.substring(8)
}
