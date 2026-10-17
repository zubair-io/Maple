package app.justmaple.aperture

import android.content.ContentValues
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.*
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class SharedFolderCacheTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private val context
        get() = instrumentation.targetContext

    private val resolver
        get() = context.contentResolver

    @Test
    fun legacyAvifDisplayBridgeReadsPinnedBytesWithoutDevelopingAgain() {
        for (name in listOf("srgb-rgb.avif", "wide-p3.avif")) {
            val original = asset(name)
            val source = File.createTempFile("legacy-source-", ".avif", context.cacheDir)
            val destination = File.createTempFile("legacy-display-", ".png", context.cacheDir)
            try {
                source.writeBytes(original)
                ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY).use { pinned
                    ->
                    // Private LRU eviction may unlink this path while its lease is open.
                    assertTrue(source.delete())
                    NativeBridge.cachePng("/proc/self/fd/${pinned.fd}", destination.absolutePath)
                    ParcelFileDescriptor.AutoCloseInputStream(
                            ParcelFileDescriptor.dup(pinned.fileDescriptor)
                        )
                        .use {
                            assertArrayEquals(original, it.readBytes())
                        }
                }
                assertTrue(NativeBridge.cacheValid(destination.absolutePath, 1280, "png"))
                val bitmap = BitmapFactory.decodeFile(destination.absolutePath)
                assertNotNull("The OS must display the private bridge", bitmap)
                bitmap!!.recycle()
            } finally {
                source.delete()
                destination.delete()
            }
        }
    }

    @Test
    fun realSafFolderReusesPortableAvifThenPublishesAndInvalidatesBothTiers() = runBlocking {
        val folderName = "MapleCache-${UUID.randomUUID()}"
        val seed =
            resolver.insert(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, "seed.txt")
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                    put(MediaStore.Downloads.RELATIVE_PATH, "Download/$folderName")
                },
            )!!
        var tree: Uri? = null
        try {
            val initial =
                DocumentsContract.buildTreeDocumentUri(
                    "com.android.externalstorage.documents",
                    "primary:Download/$folderName",
                )
            compose.runOnIdle {
                compose.activity.activityResultRegistry
                    .register(
                        "shared-cache-${UUID.randomUUID()}",
                        ActivityResultContracts.OpenDocumentTree(),
                    ) {
                        tree = it
                    }
                    .launch(
                        DocumentsContract.buildDocumentUriUsingTree(
                            initial,
                            DocumentsContract.getTreeDocumentId(initial),
                        )
                    )
            }
            clickSystem("Use this folder")
            clickSystem("Allow")
            compose.waitUntil(30_000) { tree != null }
            resolver.takePersistableUriPermission(
                tree!!,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
            val root =
                DocumentsContract.buildDocumentUriUsingTree(
                    tree!!,
                    DocumentsContract.getTreeDocumentId(tree!!),
                )
            val original = asset("portrait.dng")
            val raw = write(root, "photo.dng", "image/x-adobe-dng", original)
            // Some document providers report whole-second mtimes. The seeded cache
            // must be provably newer, rather than relying on an ambiguous equality.
            Thread.sleep(1100)
            val maple = directory(root, ".maple")
            val thumbs = directory(maple, "thumbs")
            val previews = directory(maple, "previews")
            val thumbName = "photo.dng.avif"
            val previewName = "photo.dng.avif"
            val legacyThumbName = "${PhotoLibrary.digest("photo.dng").take(16)}.v25.avif"
            val sharedBytes = asset("srgb-rgb.avif")
            // A folder written before #4793 holds the frozen versioned name; it must be adopted.
            write(thumbs, legacyThumbName, "image/avif", sharedBytes)
            write(previews, previewName, "image/avif", sharedBytes)
            val library = PhotoLibrary(context)
            val photo = library.list(root).photos.single()
            val staged = File(context.cacheDir, "originals/${PhotoLibrary.digest(photo.key)}.dng")
            assertFalse(staged.exists())
            repeat(2) {
                assertArrayEquals(sharedBytes, bytes(PhotoLibrary(context), photo, 512))
                assertArrayEquals(sharedBytes, bytes(PhotoLibrary(context), photo, 2048))
            }
            assertFalse("A shared hit must not open or stage the RAW", staged.exists())
            assertNull(find(thumbs, legacyThumbName))
            assertNotNull(find(thumbs, thumbName))
            val xml = XmpDocument().withAttribute("crs:Exposure2012", "0.5").serialize()
            val xmp = write(root, "photo.xmp", "application/rdf+xml", xml.toByteArray())
            val editedThumb = bytes(library, photo, 128)
            val editedPreview = bytes(library, photo, 2048)
            assertFalse(sharedBytes.contentEquals(editedThumb))
            assertArrayEquals(
                editedThumb,
                resolver.openInputStream(find(thumbs, thumbName)!!)!!.use { it.readBytes() },
            )
            assertArrayEquals(
                editedPreview,
                resolver.openInputStream(find(previews, previewName)!!)!!.use { it.readBytes() },
            )
            val thumbFile = File.createTempFile("shared-contract-", ".avif", context.cacheDir)
            try {
                thumbFile.writeBytes(editedThumb)
                assertTrue(NativeBridge.cacheValid(thumbFile.absolutePath, 512, "avif"))
                // The 96px RAW fixture must never be upscaled to fill a cache tier.
                assertTrue(NativeBridge.cacheValid(thumbFile.absolutePath, 96, "avif"))
                assertFalse(NativeBridge.cacheValid(thumbFile.absolutePath, 95, "avif"))
            } finally {
                thumbFile.delete()
            }
            resolver.openOutputStream(xmp, "wt")!!.use {
                it.write(
                    XmpDocument().withAttribute("crs:Exposure2012", "1.5").serialize().toByteArray()
                )
            }
            assertFalse(editedThumb.contentEquals(bytes(library, photo, 512)))
            val currentThumb = find(thumbs, thumbName)!!
            resolver.openOutputStream(currentThumb, "wt")!!.use { it.write(byteArrayOf(1, 2, 3)) }
            val repaired = bytes(library, photo, 512)
            assertArrayEquals(
                repaired,
                resolver.openInputStream(find(thumbs, thumbName)!!)!!.use { it.readBytes() },
            )
            assertTrue(repaired.size > 3)
            assertArrayEquals(original, resolver.openInputStream(raw)!!.use { it.readBytes() })
            assertNotNull(find(root, "photo.xmp"))
            assertFalse(children(thumbs).any { it.second.startsWith(".maple-") })
        } finally {
            tree?.let {
                runCatching {
                    DocumentsContract.deleteDocument(
                        resolver,
                        DocumentsContract.buildDocumentUriUsingTree(
                            it,
                            DocumentsContract.getTreeDocumentId(it),
                        ),
                    )
                }
            }
            resolver.delete(seed, null, null)
        }
    }

    @Test
    fun readOnlyAndUnsupportedProvidersUsePrivateFallbackWithoutTouchingOriginals() = runBlocking {
        val authority = "app.justmaple.aperture.test.cache-documents"
        val tree = DocumentsContract.buildTreeDocumentUri(authority, "root")
        val root = DocumentsContract.buildDocumentUriUsingTree(tree, "root")
        for (mode in listOf("readOnly", "alias", "failRename", "zeroMtime", "unsafeName")) {
            providerCall(
                "cache-test-setup",
                Bundle().apply { putBoolean(mode, true) },
            )
            try {
                val library = PhotoLibrary(context)
                val photo = library.list(root).photos.single()
                val original = resolver.openInputStream(photo.uri)!!.use { it.readBytes() }
                assertTrue(bytes(library, photo, 512).size > 10)
                assertTrue(bytes(library, photo, 2048).size > 10)
                assertArrayEquals(
                    original,
                    resolver.openInputStream(photo.uri)!!.use { it.readBytes() },
                )
                if (mode == "zeroMtime") {
                    val replacement = ByteArray(original.size)
                    resolver.openOutputStream(photo.uri, "wt")!!.use { it.write(replacement) }
                    assertTrue(
                        "A same-size replacement without mtimes must not reuse old pixels",
                        runCatching { bytes(library, photo, 512) }.isFailure,
                    )
                    assertArrayEquals(
                        replacement,
                        resolver.openInputStream(photo.uri)!!.use { it.readBytes() },
                    )
                }
                val cache = find(root, ".maple")
                if (mode == "readOnly" || mode == "zeroMtime" || mode == "unsafeName")
                    assertNull(cache)
                else
                    cache?.let { directory ->
                        for ((tier, _) in children(directory)) assertFalse(
                            children(tier).any { !it.second.startsWith(".") }
                        )
                    }
            } finally {
                providerCall("cache-test-clear")
            }
        }
    }

    @Test
    fun readOnlyFoldersReuseExistingSharedBytesAndKeepThemIntactAfterEdits() = runBlocking {
        CacheProviderFixture().use { fixture ->
            val photo = fixture.library.list(fixture.root).photos.single()
            val thumbs = fixture.directory(fixture.directory(fixture.root, ".maple"), "thumbs")
            Thread.sleep(20)
            val sharedBytes = fixture.asset("srgb-rgb.avif")
            val shared =
                fixture.write(thumbs, SharedCacheTier.Thumbnail.filename(photo.name), sharedBytes)
            fixture.mode("readOnly")
            assertArrayEquals(sharedBytes, bytes(fixture.library, photo, 512))
            fixture.call("cache-test-mode")
            Thread.sleep(20)
            fixture.write(
                fixture.root,
                "photo.xmp",
                XmpDocument().withAttribute("crs:Exposure2012", "1").serialize().toByteArray(),
            )
            fixture.mode("readOnly")
            assertFalse(sharedBytes.contentEquals(bytes(fixture.library, photo, 512)))
            assertArrayEquals(sharedBytes, fixture.read(shared))
            assertArrayEquals(fixture.original, fixture.read(photo.uri))
        }
    }

    private suspend fun bytes(library: PhotoLibrary, photo: Photo, edge: Int) =
        library.withThumbnail(photo, edge) { _, input -> input.readBytes() }

    private fun providerCall(method: String, extras: Bundle? = null): Bundle? {
        val values = extras ?: Bundle()
        if (method == "cache-test-setup") values.putByteArray("original", asset("portrait.dng"))
        return resolver.call("app.justmaple.aperture.test.cache-documents", method, null, values)
    }

    private fun asset(name: String) =
        instrumentation.context.assets.open(name).use { it.readBytes() }

    private fun directory(parent: Uri, name: String) =
        DocumentsContract.createDocument(
            resolver,
            parent,
            DocumentsContract.Document.MIME_TYPE_DIR,
            name,
        )!!

    private fun write(parent: Uri, name: String, mime: String, bytes: ByteArray): Uri {
        val created = DocumentsContract.createDocument(resolver, parent, mime, name)!!
        val uri =
            if (find(parent, name) == created) created
            else DocumentsContract.renameDocument(resolver, created, name)!!
        resolver.openOutputStream(uri, "wt")!!.use { it.write(bytes) }
        return uri
    }

    private fun find(parent: Uri, name: String) =
        children(parent).singleOrNull { it.second == name }?.first

    private fun children(parent: Uri): List<Pair<Uri, String>> {
        val uri =
            DocumentsContract.buildChildDocumentsUriUsingTree(
                parent,
                DocumentsContract.getDocumentId(parent),
            )
        return resolver
            .query(
                uri,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                ),
                null,
                null,
                null,
            )!!
            .use { cursor ->
                buildList {
                    while (cursor.moveToNext()) add(
                        DocumentsContract.buildDocumentUriUsingTree(parent, cursor.getString(0)) to
                            cursor.getString(1)
                    )
                }
            }
    }

    private fun clickSystem(label: String) {
        val deadline = System.currentTimeMillis() + 30_000
        fun find(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.text?.toString()?.equals(label, ignoreCase = true) == true) return node
            for (i in 0 until node.childCount) find(node.getChild(i))?.let {
                return it
            }
            return null
        }
        while (System.currentTimeMillis() < deadline) {
            val match = find(instrumentation.uiAutomation.rootInActiveWindow)
            if (match != null) {
                var target: AccessibilityNodeInfo = match
                while (!target.isClickable && target.parent != null) target = target.parent ?: break
                if (target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
            }
            Thread.sleep(100)
        }
        error("Missing system action $label")
    }
}
