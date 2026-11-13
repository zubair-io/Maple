package app.justmaple.aperture

import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.PhotoLibrary
import java.io.Closeable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout

/** Real files behind the debug-only provider's ordinary tree grant. */
internal class CacheProviderFixture : Closeable {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val resolver = context.contentResolver
    private val authority = "app.justmaple.aperture.test.cache-documents"
    val root: Uri =
        DocumentsContract.buildDocumentUriUsingTree(
            DocumentsContract.buildTreeDocumentUri(authority, "root"),
            "root",
        )
    val library = PhotoLibrary(context)
    val original = asset("portrait.dng")

    init {
        call("cache-test-setup", Bundle().apply { putByteArray("original", original) })
    }

    fun asset(name: String) = instrumentation.context.assets.open(name).use { it.readBytes() }

    fun call(method: String, extras: Bundle? = null) =
        resolver.call(authority, method, null, extras)

    fun mode(name: String) {
        call("cache-test-mode", Bundle().apply { putBoolean(name, true) })
    }

    suspend fun awaitBlocked() =
        withTimeout(10_000) {
            while (call("cache-test-state")?.getBoolean("blocked") != true) delay(10)
        }

    fun children(parent: Uri): List<Pair<Uri, String>> {
        val query =
            DocumentsContract.buildChildDocumentsUriUsingTree(
                parent,
                DocumentsContract.getDocumentId(parent),
            )
        return resolver
            .query(
                query,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                ),
                null,
                null,
                null,
            )!!
            .use { c ->
                buildList {
                    while (c.moveToNext()) add(
                        DocumentsContract.buildDocumentUriUsingTree(parent, c.getString(0)) to
                            c.getString(1)
                    )
                }
            }
    }

    fun find(parent: Uri, name: String) = children(parent).singleOrNull { it.second == name }?.first

    fun directory(parent: Uri, name: String) =
        find(parent, name)
            ?: DocumentsContract.createDocument(
                resolver,
                parent,
                DocumentsContract.Document.MIME_TYPE_DIR,
                name,
            )!!

    fun write(parent: Uri, name: String, bytes: ByteArray): Uri =
        (find(parent, name)
                ?: DocumentsContract.createDocument(
                    resolver,
                    parent,
                    "application/octet-stream",
                    name,
                )!!)
            .also { uri -> resolver.openOutputStream(uri, "wt")!!.use { it.write(bytes) } }

    fun read(uri: Uri) = resolver.openInputStream(uri)!!.use { it.readBytes() }

    fun modified(uri: Uri) =
        resolver
            .query(
                uri,
                arrayOf(DocumentsContract.Document.COLUMN_LAST_MODIFIED),
                null,
                null,
                null,
            )!!
            .use {
                it.moveToFirst()
                it.getLong(0)
            }

    override fun close() {
        call("cache-test-release")
        call("cache-test-clear")
    }
}
