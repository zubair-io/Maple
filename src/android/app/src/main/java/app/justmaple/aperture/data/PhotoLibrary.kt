package app.justmaple.aperture.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import java.security.MessageDigest
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
    val cloud = CloudLibrary(context)
    private val preferences = context.getSharedPreferences("maple-library", Context.MODE_PRIVATE)
    private val io = Mutex()
    private val local = LocalDocuments(context)
    private val saf = SafSidecars(context, local)
    private val originals = Mutex()
    private val derivatives = CloudDerivativeCache(cloud, File(context.cacheDir, "thumbnails"))
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
                .sortedBy { it.name.lowercase() } + cloud.sources

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
            if (CloudLibrary.isCloud(folder)) return@withContext cloud.list(folder)
            val entries = local.list(folder, fresh = true)
            LibraryListing(
                entries
                    .filter { it.directory && !it.name.startsWith(".") }
                    .map { Folder(it.uri, it.name) }
                    .sortedBy { it.name.lowercase() },
                entries
                    .filter {
                        !it.directory &&
                            it.name.substringAfterLast('.', "").lowercase() in EXTENSIONS
                    }
                    .map {
                        Photo(it.uri, it.name, it.size, it.modified, folder)
                    }
                    .sortedBy { it.name.lowercase() },
            )
        }

    suspend fun folders(folder: Uri): List<Folder> =
        withContext(Dispatchers.IO) {
            if (CloudLibrary.isCloud(folder)) cloud.list(folder).folders.filter { it.name != ".." }
            else local.folders(folder)
        }

    suspend fun single(uri: Uri): Photo =
        withContext(Dispatchers.IO) {
            val document =
                if (uri.scheme == "file")
                    DocumentFile.fromFile(File(uri.path ?: error("Missing photo path")))
                else DocumentFile.fromSingleUri(context, uri) ?: error("Photo is unavailable")
            val displayName = document.name ?: "Photo"
            val inferred =
                context.contentResolver
                    .getType(uri)
                    ?.takeIf { it.startsWith("image/") }
                    ?.substringAfterLast('-')
                    ?.substringAfter('/')
                    ?.let { if (it == "dcraw") "raw" else it }
                    ?.takeIf { it in EXTENSIONS }
            val name =
                if (!displayName.contains('.') && inferred != null) "$displayName.$inferred"
                else displayName
            require(name.substringAfterLast('.', "").lowercase() in EXTENSIONS) {
                "Maple cannot open $name. Choose a supported photo format."
            }
            Photo(uri, name, document.length(), document.lastModified(), null)
        }

    private suspend fun materialize(photo: Photo): File =
        withContext(Dispatchers.IO) {
            val folder = File(context.cacheDir, "originals").apply { mkdirs() }
            val platformDecode = photo.extension in setOf("heic", "heif", "avif")
            val extension = if (platformDecode) "tiff" else photo.extension
            val identity = if (platformDecode) "platform-rgb-v1:${photo.key}" else photo.key
            val file = File(folder, "${digest(identity)}.$extension")
            if (!file.exists()) {
                val temporary = File.createTempFile("import-", ".tmp", folder)
                try {
                    if (CloudLibrary.isCloud(photo.uri))
                        temporary.outputStream().use { cloud.copyOriginal(photo, it) }
                    else
                        context.contentResolver.openInputStream(photo.uri)?.use { input ->
                            temporary.outputStream().use(input::copyTo)
                        } ?: error("Read permission was revoked for ${photo.name}")
                    if (platformDecode) {
                        val converted = File(folder, "convert-${java.util.UUID.randomUUID()}.tiff")
                        try {
                            PlatformRasterStage.write(temporary, converted)
                            check(converted.renameTo(file)) { "Could not stage ${photo.name}" }
                        } finally {
                            converted.delete()
                        }
                    } else check(temporary.renameTo(file)) { "Could not stage ${photo.name}" }
                } finally {
                    temporary.delete()
                }
                trim(folder, 512L * 1024 * 1024, file)
            }
            file.setLastModified(System.currentTimeMillis())
            file
        }

    suspend fun <T> withOriginal(photo: Photo, action: suspend (File) -> T): T =
        originals.withLock {
            val file = materialize(photo)
            action(file)
        }

    suspend fun thumbnail(photo: Photo, edge: Int = 512): File =
        withContext(Dispatchers.IO) {
            val folder = File(context.cacheDir, "thumbnails").apply { mkdirs() }
            if (CloudLibrary.isCloud(photo.uri) && android.os.Build.VERSION.SDK_INT >= 31) {
                val remote = derivatives.load(photo, edge)
                if (remote != null) {
                    if (remote.inserted) trim(folder, 64L * 1024 * 1024, remote.file)
                    return@withContext remote.file
                }
            }
            val sidecar = io.withLock { readSidecar(photo) }
            val file =
                File(
                    folder,
                    "${digest("${AdjustmentFields.pipelineOutputVersion}:android-thumb-v3:${photo.key}:$edge:${sidecar.orEmpty()}")}.jpg",
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
                trim(folder, 64L * 1024 * 1024, file)
            }
            file.setLastModified(System.currentTimeMillis())
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
            // URI-only files from the initial #4623 pass remain untouched:
            // their source identity cannot be safely inferred for migration.
            "${digest("private-sidecar-v2:${photo.key}")}.xmp",
        )

    private fun readSidecar(photo: Photo, fresh: Boolean = false): String? =
        if (CloudLibrary.isCloud(photo.uri)) cloud.readSidecar(photo)
        else if (photo.parent == null) privateSidecar(photo).takeIf { it.exists() }?.readText()
        else saf.read(photo, fresh)

    suspend fun loadSidecar(photo: Photo): LoadedSidecar = io.withLock {
        withContext(Dispatchers.IO) {
            val xml = readSidecar(photo, fresh = true)
            LoadedSidecar(XmpDocument(xml ?: XmpDocument.EMPTY).also { it.serialize() }, xml)
        }
    }

    suspend fun save(photo: Photo, document: XmpDocument, baseline: String?): LoadedSidecar =
        io.withLock {
            withContext(Dispatchers.IO) {
                if (CloudLibrary.isCloud(photo.uri))
                    return@withContext cloud.save(photo, document, baseline)
                val xml = document.serialize()
                if (photo.parent != null) saf.save(photo, xml, baseline)
                else {
                    check(readSidecar(photo) == baseline) {
                        "The sidecar changed outside Maple. Reopen the photo before saving."
                    }
                    val target = privateSidecar(photo)
                    val temp = File.createTempFile("sidecar-", ".xmp", target.parentFile)
                    try {
                        temp.writeText(xml)
                        check(temp.renameTo(target)) { "Could not save sidecar" }
                    } finally {
                        temp.delete()
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
                "heic",
                "heif",
            ) + if (android.os.Build.VERSION.SDK_INT >= 31) setOf("avif") else emptySet()

        fun digest(value: String) =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") {
                "%02x".format(it)
            }
    }
}
