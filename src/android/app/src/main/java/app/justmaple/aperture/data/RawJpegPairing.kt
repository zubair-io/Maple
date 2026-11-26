package app.justmaple.aperture.data

import app.justmaple.aperture.cloud.CloudLibrary
import java.text.Normalizer

/**
 * The server's name rule (`library/raw-jpeg-stack.ts`) for folders that list plain files: a stem
 * pairs only when it holds exactly one RAW and exactly one `.jpg`/`.jpeg`.
 */
internal object RawJpegPairing {
    val RAW_EXTENSIONS =
        setOf(
            "cr2",
            "cr3",
            "nef",
            "arw",
            "dng",
            "raf",
            "orf",
            "rw2",
            "pef",
            "srw",
            "x3f",
            "3fr",
            "mef",
            "erf",
            "mrw",
            "raw",
            "fff",
        )
    private val JPEG_EXTENSIONS = setOf("jpg", "jpeg")

    private fun extensionStart(name: String): Int =
        name.lastIndexOf('.').takeIf { it > 0 } ?: name.length

    fun extension(name: String): String = name.substring(extensionStart(name)).drop(1).lowercase()

    fun stem(name: String): String =
        Normalizer.normalize(name.substring(0, extensionStart(name)), Normalizer.Form.NFC)
            .lowercase()

    /** The pairs among one folder's file names, keyed by the RAW's name. */
    fun pairs(names: List<String>): Map<String, String> =
        names
            .groupBy(::stem)
            .values
            .mapNotNull { members ->
                val raws = members.filter { extension(it) in RAW_EXTENSIONS }
                val jpegs = members.filter { extension(it) in JPEG_EXTENSIONS }
                if (raws.size == 1 && jpegs.size == 1) raws.single() to jpegs.single() else null
            }
            .toMap()

    fun fold(photos: List<Photo>): List<Photo> {
        val pairs = pairs(photos.map { it.name })
        val jpegs = pairs.values.toSet()
        val byName = photos.associateBy { it.name }
        return photos
            .filterNot { it.name in jpegs }
            .map { photo ->
                pairs[photo.name]?.let(byName::get)?.let { photo.copy(companion = it) } ?: photo
            }
    }

    fun folderToRelist(open: Folder?): Folder? = open?.takeUnless { CloudLibrary.isCloud(it.uri) }
}
