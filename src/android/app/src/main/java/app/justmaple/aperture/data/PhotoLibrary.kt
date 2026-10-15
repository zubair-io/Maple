package app.justmaple.aperture.data

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class Photo(
    val uri: Uri,
    val name: String,
    val size: Long,
    val modified: Long,
    val parent: Uri?,
) {
    val extension
        get() = name.substringAfterLast('.', "").lowercase()

    val sidecarName
        get() = name.substringBeforeLast('.') + ".xmp"

    val key
        get() = "$uri:$size:$modified"
}

data class Folder(val uri: Uri, val name: String)

data class LibraryListing(val folders: List<Folder>, val photos: List<Photo>)

data class LoadedSidecar(val document: XmpDocument, val baseline: String?)

class PhotoLibrary(private val context: Context) {
    private val preferences = context.getSharedPreferences("maple-library", Context.MODE_PRIVATE)
    private val io = Mutex()
    private val originals = Mutex()
    val sources: List<Folder>
        get() =
            preferences
                .getStringSet("sources", emptySet())
                .orEmpty()
                .mapNotNull { value ->
                    runCatching { DocumentFile.fromTreeUri(context, Uri.parse(value)) }
                        .getOrNull()
                        ?.let { Folder(it.uri, it.name ?: "Folder") }
                }
                .sortedBy { it.name.lowercase() }

    fun remember(uri: Uri) {
        context.contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        preferences
            .edit()
            .putStringSet(
                "sources",
                preferences.getStringSet("sources", emptySet()).orEmpty() + uri.toString(),
            )
            .apply()
    }

    suspend fun list(folder: Uri): LibraryListing =
        withContext(Dispatchers.IO) {
            val entries = children(folder)
            LibraryListing(
                entries
                    .filter { it.isDirectory }
                    .map { Folder(it.uri, it.name ?: "Folder") }
                    .sortedBy { it.name.lowercase() },
                entries
                    .filter {
                        it.isFile && it.name?.substringAfterLast('.', "")?.lowercase() in EXTENSIONS
                    }
                    .map {
                        Photo(it.uri, it.name ?: "Photo", it.length(), it.lastModified(), folder)
                    }
                    .sortedBy { it.name.lowercase() },
            )
        }

    suspend fun single(uri: Uri): Photo =
        withContext(Dispatchers.IO) {
            val document =
                if (uri.scheme == "file")
                    DocumentFile.fromFile(File(uri.path ?: error("Missing photo path")))
                else DocumentFile.fromSingleUri(context, uri) ?: error("Photo is unavailable")
            Photo(uri, document.name ?: "Photo", document.length(), document.lastModified(), null)
        }

    private suspend fun materialize(photo: Photo): File =
        withContext(Dispatchers.IO) {
            val folder = File(context.cacheDir, "originals").apply { mkdirs() }
            val platformDecode = photo.extension in setOf("heic", "heif")
            val extension = if (platformDecode) "png" else photo.extension
            val file = File(folder, "${digest(photo.key)}.$extension")
            if (!file.exists()) {
                val temporary = File.createTempFile("import-", ".tmp", folder)
                try {
                    context.contentResolver.openInputStream(photo.uri)?.use { input ->
                        temporary.outputStream().use(input::copyTo)
                    } ?: error("Read permission was revoked for ${photo.name}")
                    if (platformDecode) {
                        val bitmap =
                            ImageDecoder.decodeBitmap(ImageDecoder.createSource(temporary)) {
                                decoder,
                                _,
                                _ ->
                                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                                decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
                            }
                        val converted = File.createTempFile("convert-", ".tmp", folder)
                        try {
                            converted.outputStream().use { output ->
                                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                                    "Cannot decode ${photo.name}"
                                }
                            }
                            check(converted.renameTo(file)) { "Could not stage ${photo.name}" }
                        } finally {
                            converted.delete()
                            bitmap.recycle()
                        }
                    } else check(temporary.renameTo(file)) { "Could not stage ${photo.name}" }
                } finally {
                    temporary.delete()
                }
            }
            file
        }

    suspend fun <T> withOriginal(photo: Photo, action: suspend (File) -> T): T =
        originals.withLock {
            val file = materialize(photo)
            try {
                action(file)
            } finally {
                withContext(Dispatchers.IO) { trim(file.parentFile!!, 512L * 1024 * 1024, file) }
            }
        }

    suspend fun thumbnail(photo: Photo, edge: Int = 512): File =
        withContext(Dispatchers.IO) {
            val folder = File(context.cacheDir, "thumbnails").apply { mkdirs() }
            val sidecar = readSidecar(photo)
            val file =
                File(
                    folder,
                    "${digest("${AdjustmentFields.pipelineOutputVersion}:${photo.key}:$edge:${sidecar.orEmpty()}")}.jpg",
                )
            if (!file.exists()) {
                val temporary = File.createTempFile("thumb-", ".jpg", folder)
                try {
                    withOriginal(photo) { input ->
                        NativeBridge.thumbnail(
                            input.absolutePath,
                            temporary.absolutePath,
                            sidecar.orEmpty(),
                            edge,
                        )
                    }
                    check(temporary.renameTo(file))
                } finally {
                    temporary.delete()
                }
            }
            file.setLastModified(System.currentTimeMillis())
            trim(folder, 64L * 1024 * 1024, file)
            file
        }

    private fun trim(folder: File, limit: Long, keep: File) {
        val entries =
            folder
                .listFiles()
                .orEmpty()
                .filter { it.isFile && !it.name.endsWith(".tmp") && !it.name.startsWith("thumb-") }
                .sortedByDescending { it.lastModified() }
        var bytes = 0L
        for (file in entries) {
            bytes += file.length()
            if (bytes > limit && file != keep) file.delete()
        }
    }

    private fun privateSidecar(photo: Photo) =
        File(
            File(context.filesDir, "sidecars").apply { mkdirs() },
            "${digest(photo.uri.toString())}.xmp",
        )

    private fun children(folder: Uri): List<DocumentFile> {
        val id = DocumentsContract.getDocumentId(folder)
        val query = DocumentsContract.buildChildDocumentsUriUsingTree(folder, id)
        return context.contentResolver
            .query(query, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)
            ?.use { cursor ->
                buildList {
                    while (cursor.moveToNext()) {
                        val uri =
                            DocumentsContract.buildDocumentUriUsingTree(folder, cursor.getString(0))
                        DocumentFile.fromSingleUri(context, uri)?.let(::add)
                    }
                }
            } ?: error("Folder permission is unavailable")
    }

    private fun sidecar(photo: Photo): DocumentFile? =
        photo.parent?.let { children(it).find { entry -> entry.name == photo.sidecarName } }

    private fun readSidecar(photo: Photo): String? =
        if (photo.parent == null) privateSidecar(photo).takeIf { it.exists() }?.readText()
        else
            sidecar(photo)?.let { document ->
                context.contentResolver.openInputStream(document.uri)?.bufferedReader()?.use {
                    it.readText()
                } ?: error("Cannot read sidecar")
            }

    suspend fun loadSidecar(photo: Photo): LoadedSidecar =
        withContext(Dispatchers.IO) {
            val xml = readSidecar(photo)
            LoadedSidecar(XmpDocument(xml ?: XmpDocument.EMPTY).also { it.serialize() }, xml)
        }

    suspend fun save(photo: Photo, document: XmpDocument, baseline: String?): LoadedSidecar =
        io.withLock {
            withContext(Dispatchers.IO) {
                check(readSidecar(photo) == baseline) {
                    "The sidecar changed outside Maple. Reopen the photo before saving."
                }
                val xml = document.serialize()
                if (photo.parent == null) {
                    val target = privateSidecar(photo)
                    val temp = File.createTempFile("sidecar-", ".xmp", target.parentFile)
                    try {
                        temp.writeText(xml)
                        check(temp.renameTo(target)) { "Could not save sidecar" }
                    } finally {
                        temp.delete()
                    }
                } else {
                    val root =
                        DocumentFile.fromSingleUri(context, photo.parent)
                            ?: error("Folder is unavailable")
                    check(root.canWrite()) { "Folder is read-only" }
                    val temporaryUri =
                        DocumentsContract.createDocument(
                            context.contentResolver,
                            root.uri,
                            "application/rdf+xml",
                            ".maple-${UUID.randomUUID()}.xmp",
                        ) ?: error("Cannot create sidecar")
                    val temp =
                        DocumentFile.fromSingleUri(context, temporaryUri)
                            ?: error("Cannot read new sidecar")
                    val previous = sidecar(photo)
                    val backup = ".maple-${UUID.randomUUID()}.backup.xmp"
                    try {
                        context.contentResolver.openOutputStream(temp.uri, "wt")?.use {
                            it.write(xml.toByteArray(Charsets.UTF_8))
                            it.flush()
                        } ?: error("Cannot write sidecar")
                        check(readSidecar(photo) == baseline) { "The sidecar changed while saving" }
                        if (previous != null)
                            check(previous.renameTo(backup)) { "Cannot replace sidecar safely" }
                        if (!temp.renameTo(photo.sidecarName)) {
                            previous?.renameTo(photo.sidecarName)
                            error("Could not publish sidecar")
                        }
                        previous?.delete()
                    } finally {
                        if (temp.name != photo.sidecarName) temp.delete()
                    }
                }
                LoadedSidecar(XmpDocument(xml), xml)
            }
        }

    companion object {
        val EXTENSIONS =
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
                "jpg",
                "jpeg",
                "png",
                "webp",
                "tif",
                "tiff",
                "avif",
                "heic",
                "heif",
            )

        fun digest(value: String) =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") {
                "%02x".format(it)
            }
    }
}
