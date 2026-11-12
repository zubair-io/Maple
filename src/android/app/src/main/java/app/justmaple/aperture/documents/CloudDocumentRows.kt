package app.justmaple.aperture.documents

import android.database.Cursor
import android.database.MatrixCursor
import android.provider.DocumentsContract.Document
import android.webkit.MimeTypeMap

internal data class CloudDocumentRow(
    val id: String,
    val name: String,
    val mime: String,
    val size: Long?,
    val modified: Long?,
    val flags: Int,
)

/** SAF projection of Maple Cloud items. Capabilities follow what the server contract allows. */
internal object CloudDocumentRows {
    val DEFAULT_PROJECTION =
        arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
        )

    private val RAW_TYPES =
        mapOf(
            "dng" to "image/x-adobe-dng",
            "cr2" to "image/x-canon-cr2",
            "cr3" to "image/x-canon-cr3",
            "crw" to "image/x-canon-crw",
            "nef" to "image/x-nikon-nef",
            "nrw" to "image/x-nikon-nrw",
            "arw" to "image/x-sony-arw",
            "srf" to "image/x-sony-srf",
            "sr2" to "image/x-sony-sr2",
            "raf" to "image/x-fuji-raf",
            "orf" to "image/x-olympus-orf",
            "rw2" to "image/x-panasonic-rw2",
            "pef" to "image/x-pentax-pef",
            "srw" to "image/x-samsung-srw",
            "x3f" to "image/x-sigma-x3f",
            "3fr" to "image/x-hasselblad-3fr",
            "fff" to "image/x-hasselblad-fff",
            "mrw" to "image/x-minolta-mrw",
            "mef" to "image/x-mamiya-mef",
            "erf" to "image/x-epson-erf",
            "iiq" to "image/x-phaseone-iiq",
            "raw" to "image/x-dcraw",
            "heic" to "image/heic",
            "heif" to "image/heif",
            "avif" to "image/avif",
            "xmp" to "application/rdf+xml",
        )

    fun mime(name: String): String {
        val extension = name.substringAfterLast('.', "").lowercase()
        if (extension.isEmpty()) return "application/octet-stream"
        return RAW_TYPES[extension]
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
            ?: "application/octet-stream"
    }

    /** Appends the MIME type's extension when a creating app named the file without one. */
    fun nameFor(displayName: String, mime: String): String {
        if (mime == Document.MIME_TYPE_DIR || mime == "application/octet-stream") return displayName
        if (mime(displayName).equals(mime, ignoreCase = true)) return displayName
        val extension =
            RAW_TYPES.entries.firstOrNull { it.value.equals(mime, ignoreCase = true) }?.key
                ?: MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
                ?: return displayName
        return "$displayName.$extension"
    }

    /** `photo (1).jpg`, `photo (2).jpg`, … the platform's own collision naming. */
    fun unique(name: String, directory: Boolean, taken: Set<String>): String {
        if (name !in taken) return name
        val dot = if (directory) -1 else name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val suffix = if (dot > 0) name.substring(dot) else ""
        return generateSequence(1) { it + 1 }
            .map { "$stem ($it)$suffix" }
            .first { it !in taken }
    }

    fun library(id: CloudDocumentId, title: String) =
        CloudDocumentRow(id.encode(), title, Document.MIME_TYPE_DIR, null, null, Document.FLAG_DIR_SUPPORTS_CREATE)

    fun entry(id: CloudDocumentId, entry: CloudEntry): CloudDocumentRow =
        CloudDocumentRow(
            id.encode(),
            entry.name,
            if (entry.kind == CloudEntryKind.Folder) Document.MIME_TYPE_DIR else mime(entry.name),
            entry.size,
            entry.modified,
            flags(entry),
        )

    /** A document written here that the server has not accepted yet. */
    fun pending(id: CloudDocumentId, size: Long, modified: Long) =
        CloudDocumentRow(
            id.encode(),
            id.name,
            mime(id.name),
            size,
            modified,
            Document.FLAG_SUPPORTS_WRITE or
                Document.FLAG_SUPPORTS_DELETE or
                Document.FLAG_SUPPORTS_REMOVE,
        )

    // Originals are never modified and sidecars are written only through Maple's
    // conditional XMP saves, so neither is writable here. The server has no folder
    // removal, so folders cannot be deleted.
    fun flags(entry: CloudEntry): Int {
        val trash = Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_REMOVE
        val catalogued = if (entry.indexed) Document.FLAG_SUPPORTS_RENAME or trash else 0
        return when (entry.kind) {
            CloudEntryKind.Folder -> Document.FLAG_DIR_SUPPORTS_CREATE or Document.FLAG_SUPPORTS_RENAME
            CloudEntryKind.Photo -> Document.FLAG_SUPPORTS_THUMBNAIL or catalogued
            CloudEntryKind.Media -> catalogued
            CloudEntryKind.File -> Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_RENAME or trash
            CloudEntryKind.Sidecar -> 0
        }
    }

    fun cursor(projection: Array<out String>?, rows: List<CloudDocumentRow>): MatrixCursor {
        val cursor = MatrixCursor(projection ?: DEFAULT_PROJECTION)
        for (row in rows) {
            cursor.addRow(
                cursor.columnNames.map { column ->
                    when (column) {
                        Document.COLUMN_DOCUMENT_ID -> row.id
                        Document.COLUMN_DISPLAY_NAME -> row.name
                        Document.COLUMN_MIME_TYPE -> row.mime
                        Document.COLUMN_SIZE -> row.size
                        Document.COLUMN_LAST_MODIFIED -> row.modified
                        Document.COLUMN_FLAGS -> row.flags
                        else -> null
                    }
                }
            )
        }
        return cursor
    }

    fun empty(projection: Array<out String>?): Cursor = MatrixCursor(projection ?: DEFAULT_PROJECTION)
}
