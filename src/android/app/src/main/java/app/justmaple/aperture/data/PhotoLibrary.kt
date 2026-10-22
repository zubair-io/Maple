package app.justmaple.aperture.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import app.justmaple.aperture.cloud.CloudLibrary
import java.io.File
import java.io.FileInputStream
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.io.StringReader
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class Photo(
    val uri: Uri,
    val name: String,
    val size: Long,
    val modified: Long,
    val parent: Uri?,
    val contentDigest: String? = null,
) {
    val extension
        get() = name.substringAfterLast('.', "").lowercase()

    val sidecarName
        get() = name.substringBeforeLast('.') + ".xmp"

    val key
        get() = "$uri:$size:$modified" + (contentDigest?.let { ":sha256:$it" } ?: "")
}

data class Folder(val uri: Uri, val name: String)

data class LibraryListing(val folders: List<Folder>, val photos: List<Photo>)

data class LoadedSidecar(val document: XmpDocument, val baseline: String?)

class PhotoLibrary(private val context: Context) {
    val cloud = CloudLibrary(context)
    private val preferences = context.getSharedPreferences("maple-library", Context.MODE_PRIVATE)
    private val local = LocalDocuments(context)
    private val saf = SafSidecars(context, local)
    private val shared = FolderDerivativeCache(context)
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
            val folder = File(context.cacheDir, "originals").apply { mkdirs() }
            val temporary = File.createTempFile("import-", ".tmp", folder)
            try {
                val hash = MessageDigest.getInstance("SHA-256")
                context.contentResolver.openInputStream(uri)?.use { input ->
                    temporary.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            hash.update(buffer, 0, count)
                        }
                    }
                } ?: error("Read permission was revoked for $name")
                val photo =
                    Photo(
                        uri,
                        name,
                        temporary.length(),
                        document.lastModified(),
                        null,
                        hash.digest().joinToString("") { "%02x".format(it) },
                    )
                val staged = singleSnapshot(photo, folder)
                originals.withLock {
                    check(temporary.renameTo(staged)) { "Could not stage $name" }
                    staged.setLastModified(System.currentTimeMillis())
                    trim(folder, 512L * 1024 * 1024, setOf(staged))
                }
                photo
            } finally {
                temporary.delete()
            }
        }

    private fun singleSnapshot(photo: Photo, folder: File): File {
        val identity =
            if (photo.extension in setOf("heic", "heif", "avif")) "single-input:${photo.key}"
            else photo.key
        return File(folder, "${digest(identity)}.${photo.extension}")
    }

    private suspend fun materialize(photo: Photo, edge: Int?): File =
        withContext(Dispatchers.IO) {
            val folder = File(context.cacheDir, "originals").apply { mkdirs() }
            if (photo.extension !in setOf("heic", "heif", "avif"))
                return@withContext sourceOriginal(photo, folder)
            val file =
                File(folder, "${digest("platform-rgb-v2:${edge ?: "full"}:${photo.key}")}.tiff")
            if (!file.exists()) {
                val source = sourceOriginal(photo, folder)
                val converted = File(folder, "convert-${java.util.UUID.randomUUID()}.tiff")
                try {
                    PlatformRasterStage.write(source, converted, edge)
                    check(converted.renameTo(file)) { "Could not stage ${photo.name}" }
                } finally {
                    converted.delete()
                }
                trim(folder, 512L * 1024 * 1024, setOf(source, file))
            }
            file.setLastModified(System.currentTimeMillis())
            file
        }

    private fun sourceOriginal(photo: Photo, folder: File): File {
        val file =
            if (photo.contentDigest != null) singleSnapshot(photo, folder)
            else File(folder, "${digest(photo.key)}.${photo.extension}")
        if (!file.exists()) {
            check(photo.contentDigest == null) {
                "The imported photo cache was cleared. Reopen the photo."
            }
            val temporary = File.createTempFile("import-", ".tmp", folder)
            try {
                if (CloudLibrary.isCloud(photo.uri))
                    temporary.outputStream().use { cloud.copyOriginal(photo, it) }
                else
                    context.contentResolver.openInputStream(photo.uri)?.use { input ->
                        temporary.outputStream().use(input::copyTo)
                    } ?: error("Read permission was revoked for ${photo.name}")
                check(temporary.renameTo(file)) { "Could not stage ${photo.name}" }
            } finally {
                temporary.delete()
            }
            trim(folder, 512L * 1024 * 1024, setOf(file))
        }
        file.setLastModified(System.currentTimeMillis())
        return file
    }

    /** Metadata reads retain the immutable original without creating a full OS-decoded raster. */
    suspend fun <T> withSourceMetadata(photo: Photo, action: suspend (File) -> T): T = originals.withLock {
        val source = withContext(Dispatchers.IO) {
            val folder = File(context.cacheDir, "originals").apply { mkdirs() }
            sourceOriginal(photo, folder)
        }
        action(source)
    }

    suspend fun <T> withOriginal(photo: Photo, action: suspend (File) -> T): T =
        withMaterialized(photo, null, action)

    suspend fun <T> withPreview(photo: Photo, edge: Int, action: suspend (File) -> T): T =
        withMaterialized(photo, edge, action)

    private suspend fun <T> withMaterialized(
        photo: Photo,
        edge: Int?,
        action: suspend (File) -> T,
    ): T = originals.withLock {
        val file = materialize(photo, edge)
        action(file)
    }

    suspend fun <T> withThumbnail(
        photo: Photo,
        edge: Int = 512,
        action: suspend (File?, FileInputStream) -> T,
    ): T =
        withContext(Dispatchers.IO) {
            thumbnail(photo, edge).use { action(it.file, it.input) }
        }

    private suspend fun thumbnail(photo: Photo, edge: Int): OpenThumbnail {
        val folder = File(context.cacheDir, "thumbnails").apply { mkdirs() }
        if (photo.parent != null && !CloudLibrary.isCloud(photo.uri)) {
            val result =
                shared.load(edge, { folderCacheSource(photo) }) { source, target, tier ->
                    withPreview(source.photo, tier.edge) { input ->
                        NativeBridge.sharedDerivative(
                            input.absolutePath,
                            target.absolutePath,
                            source.xml.orEmpty(),
                            tier == SharedCacheTier.Preview,
                        )
                    }
                }
            try {
                if (result.inserted) trim(folder, 64L * 1024 * 1024, setOfNotNull(result.image.file))
                return result.image
            } catch (failure: Throwable) {
                result.image.close()
                throw failure
            }
        }
        if (CloudLibrary.isCloud(photo.uri) && android.os.Build.VERSION.SDK_INT >= 31) {
            val remote = derivatives.load(photo, edge)
            if (remote != null) {
                try {
                    if (remote.inserted)
                        trim(folder, 64L * 1024 * 1024, setOfNotNull(remote.image.file, remote.index))
                    return remote.image
                } catch (failure: Throwable) {
                    remote.image.close()
                    throw failure
                }
            }
        }
        val sidecar = io.withLock { readSidecar(photo) }
        val file =
            File(
                folder,
                "${digestParts("android-thumb-v4:${photo.key}:$edge:", sidecar.orEmpty())}.jpg",
            )
        val cached =
            synchronized(OpenThumbnail.lock) {
                if (file.isFile) {
                    file.setLastModified(System.currentTimeMillis())
                    OpenThumbnail(file)
                } else null
            }
        if (cached != null) return cached
        val temporary = File.createTempFile("thumb-", ".jpg", folder)
        try {
            withPreview(photo, edge) { input ->
                NativeBridge.thumbnail(
                    input.absolutePath,
                    temporary.absolutePath,
                    sidecar.orEmpty(),
                    edge,
                )
            }
            return synchronized(OpenThumbnail.lock) {
                check(temporary.renameTo(file))
                trim(folder, 64L * 1024 * 1024, setOf(file))
                OpenThumbnail(file)
            }
        } finally {
            temporary.delete()
        }
    }

    private fun trim(folder: File, limit: Long, keep: Set<File>) =
        synchronized(OpenThumbnail.lock) {
            val files =
                folder.listFiles().orEmpty().filter {
                    it.isFile && !it.name.endsWith(".tmp") && !it.name.startsWith("thumb-")
                }
            val indexed =
                files
                    .mapNotNull { file ->
                        val key =
                            CLOUD_INDEX.matchEntire(file.name)?.groupValues?.get(1)
                                ?: return@mapNotNull null
                        val content = runCatching {
                            org.json.JSONObject(file.readText()).getString("content")
                        }
                            .getOrNull()
                        if (content?.matches(Regex("[0-9a-f]{64}")) == true) key to content
                        else null
                    }
                    .toMap()
            val entries =
                files
                    .groupBy { file ->
                        val index = CLOUD_INDEX.matchEntire(file.name)?.groupValues?.get(1)
                        val payload = CLOUD_PAYLOAD.matchEntire(file.name)
                        when {
                            index != null && index in indexed -> "cloud-$index"
                            payload != null &&
                                indexed[payload.groupValues[1]] == payload.groupValues[2] ->
                                "cloud-${payload.groupValues[1]}"
                            else -> file.name
                        }
                    }
                    .values
                    .sortedByDescending { entry -> entry.maxOf { it.lastModified() } }
            val protected = entries.filter { entry -> entry.any { it in keep } }
            var bytes = protected.sumOf { entry -> entry.sumOf { it.length() } }
            for (entry in entries.filter { group -> group.none { it in keep } }) {
                val size = entry.sumOf { it.length() }
                if (bytes + size <= limit) bytes += size else entry.forEach { it.delete() }
            }
        }

    private fun privateSidecar(photo: Photo) =
        File(
            File(context.filesDir, "sidecars").apply { mkdirs() },
            // Earlier URI/metadata-only identities remain untouched and unassigned.
            "${digest("private-sidecar-v3:${photo.key}")}.xmp",
        )

    private fun readSidecar(photo: Photo, fresh: Boolean = false): String? =
        if (CloudLibrary.isCloud(photo.uri)) cloud.readSidecar(photo)
        else if (photo.parent == null)
            privateSidecar(photo).takeIf { it.exists() }?.let { XmpEncoding.decode(it.readBytes()) }
        else saf.read(photo, fresh)

    private suspend fun folderCacheSource(photo: Photo): FolderCacheSource = io.withLock {
        val xml = readSidecar(photo, fresh = true)
        val entries = local.list(photo.parent!!, fresh = true)
        val original =
            entries.singleOrNull { it.uri == photo.uri && !it.directory }
                ?: error("The photo is no longer in this folder")
        check(original.name == photo.name) {
            "The photo was renamed. Reopen the folder before loading its preview."
        }
        val sidecars = entries.filter { it.name.equals(photo.sidecarName, ignoreCase = true) }
        check(sidecars.size <= 1) { "Multiple sidecars match this photo" }
        val current =
            if (original.modified <= 0L || original.size <= 0L)
                single(photo.uri).copy(parent = photo.parent)
            else photo.copy(size = original.size, modified = original.modified)
        FolderCacheSource(
            current,
            xml,
            sidecars.singleOrNull(),
        )
    }

    suspend fun loadSidecar(photo: Photo): LoadedSidecar = io.withLock {
        withContext(Dispatchers.IO) {
            val xml = readSidecar(photo, fresh = true)
            LoadedSidecar(XmpDocument(xml ?: XmpDocument.EMPTY), xml)
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
                        temp.writeBytes(XmpEncoding.encode(xml))
                        check(temp.renameTo(target)) { "Could not save sidecar" }
                    } finally {
                        temp.delete()
                    }
                }
                LoadedSidecar(XmpDocument(xml), xml)
            }
        }

    companion object {
        // Journals and sidecar files are shared by every library instance (#4771).
        // A reader can recover/rename them, so reads and saves need the same lock.
        private val io = Mutex()
        private val originals = Mutex()

        private val CLOUD_INDEX = Regex("cloud-([0-9a-f]{64})\\.json")
        private val CLOUD_PAYLOAD = Regex("cloud-([0-9a-f]{64})-([0-9a-f]{64})\\.avif")
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

        fun digest(value: String): String = digestParts(value)

        internal fun digestParts(vararg parts: String): String {
            val hash = MessageDigest.getInstance("SHA-256")
            val sink =
                object : OutputStream() {
                    override fun write(value: Int) {
                        hash.update(value.toByte())
                    }

                    override fun write(bytes: ByteArray, offset: Int, length: Int) {
                        hash.update(bytes, offset, length)
                    }
                }
            OutputStreamWriter(sink, Charsets.UTF_8).use { writer ->
                for (part in parts) StringReader(part).use { it.copyTo(writer, 4096) }
            }
            return hash.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
