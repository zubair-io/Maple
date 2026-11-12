package app.justmaple.aperture.documents

import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.util.Base64
import app.justmaple.aperture.cloud.CloudResponse
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.cloud.CloudTransport
import java.io.File
import java.io.FileNotFoundException
import java.io.OutputStream
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Provider reads and writes against an in-process server speaking the Maple routes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudDocumentWritesTest {
    private val server = "0f3c2c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
    private val library = "6af556d774fc0bdbaa866c39"
    private val folder = CloudDocumentId.folder(server, library, "photos", "2026")
    private val root = Files.createTempDirectory("documents").toFile()
    private val api = FakeServer()
    private var connections = listOf(CloudServer(server, "https://maple.test", token("ann"), "r"))
    private val loads = ArrayDeque<Runnable>()
    private val uploads = CloudPendingUploads(File(root, "uploads"))

    private fun store() =
        CloudDocumentStore(
            { connections },
            CloudDocumentsApi(api),
            uploads,
            RuntimeEnvironment.getApplication().contentResolver,
            Executor { loads.addLast(it) },
        )

    private fun writes(store: CloudDocumentStore) =
        CloudDocumentWrites(store, uploads, Handler(Looper.getMainLooper()), Executor { it.run() })

    private fun file(name: String) = folder.child(name, false)

    private fun writable(row: CloudDocumentRow) = row.flags and Document.FLAG_SUPPORTS_WRITE != 0

    @Test
    fun originalsStayReadOnlyAfterAReadAndWhenOnlyTheirNameIsKnown() {
        api.page("2026", images = listOf("clip.gif", "IMG_1.CR3", "IMG_1.JPG"), files = listOf("notes.txt"))
        val listed = store()
        assertEquals(
            setOf("clip.gif", "IMG_1.CR3", "IMG_1.JPG", "notes.txt"),
            listed.children(folder).rows.mapTo(HashSet()) { it.name },
        )
        // The read path stats the file; that must not reclassify a server original as a plain file.
        listed.stat(file("clip.gif"))
        assertFalse(writable(listed.row(file("clip.gif"))))
        assertThrows(FileNotFoundException::class.java) {
            writes(listed).openForWrite(file("clip.gif"), "w", null)
        }
        // Nothing cached: the kind comes from the folder listing, never from the extension.
        val fresh = store()
        assertFalse(writable(fresh.row(file("clip.gif"))))
        assertThrows(FileNotFoundException::class.java) { writes(store()).openForWrite(file("clip.gif"), "w", null) }
        assertTrue(writable(store().row(file("notes.txt"))))
        assertTrue(api.requests.none { it.contains("file-meta") && it.contains("notes.txt") })
        assertTrue(uploads.all(account("ann")).isEmpty())
    }

    @Test
    fun aRawJpegPairIsTwoDocumentsAndCreateNeverTakesTheJpegsName() {
        api.page("2026", images = listOf("IMG_1.CR3", "IMG_1.JPG"))
        val store = store()
        val names = store.children(folder).rows.map { it.name }
        assertEquals(listOf("IMG_1.CR3", "IMG_1.JPG"), names)
        assertTrue("The provider asks for the unfolded listing", api.requests.none { it.contains("stack=") })
        val created = writes(store).create(folder, "image/jpeg", "IMG_1.JPG")
        assertEquals("IMG_1 (1).JPG", created.name)
        assertEquals(listOf("2026/IMG_1 (1).JPG"), uploads.all(account("ann")).map { it.path })
    }

    @Test
    fun pendingUploadsBelongToTheAccountThatWroteThem() {
        api.page("2026")
        ready("ann", "2026/a.txt")
        connections = listOf(CloudServer(server, "https://maple.test", token("bob"), "r"))
        val bob = store()
        writes(bob).schedule(server)
        assertTrue("Another account's token never carries the bytes", api.uploads.isEmpty())
        assertTrue(bob.children(folder).rows.isEmpty())
        connections = listOf(CloudServer(server, "https://maple.test", token("ann"), "r2"))
        writes(store()).schedule(server)
        assertEquals(listOf("2026/a.txt"), api.uploads)
        assertTrue(uploads.all(account("ann")).isEmpty())
    }

    @Test
    fun aRejectedUploadIsTerminalAndTheRestStillGoOut() {
        api.page("2026")
        val denied = ready("ann", "2026/denied.txt", age = 3)
        ready("ann", "2026/later.txt", age = 2)
        api.status = { path -> if (path.endsWith("denied.txt")) 403 else 201 }
        val store = store()
        writes(store).schedule(server)
        assertEquals(listOf("2026/denied.txt", "2026/later.txt"), api.uploads)
        val left = uploads.all(account("ann")).single()
        assertEquals(denied.token, left.token)
        assertNotNull(left.failure)
        assertTrue(uploads.due(account("ann")).isEmpty())
        val row = store.children(folder).rows.single()
        assertTrue(row.summary!!.startsWith("Not uploaded:"))

        // A session the server no longer accepts pauses the queue without failing anything.
        val paused = ready("ann", "2026/paused.txt")
        api.status = { 401 }
        writes(store).schedule(server)
        assertNull(uploads.all(account("ann")).single { it.token == paused.token }.failure)
        assertEquals(1, uploads.due(account("ann")).size)
    }

    @Test
    fun aTornWriterNeverUploadsAndAReopenedRecordOutlivesAnInFlightSuccess() {
        val torn = uploads.create(account("ann"), file("torn.txt"), writing = true)
        uploads.data(torn).writeText("half")
        uploads.closed(torn, clean = false)
        uploads.data(torn).setLastModified(System.currentTimeMillis() - 2 * CloudPendingUploads.IDLE_MILLIS)
        assertTrue(uploads.due(account("ann")).isEmpty())
        assertEquals(CloudPendingUploads.INTERRUPTED, uploads.all(account("ann")).single().failure)

        uploads.closed(uploads.opened(torn), clean = true)
        val sending = uploads.due(account("ann")).single()
        val rewriting = uploads.opened(sending)
        assertFalse("Bytes written after the send started stay queued", uploads.sent(sending))
        uploads.closed(rewriting, clean = true)
        assertEquals(torn.token, uploads.due(account("ann")).single().token)
        assertTrue(uploads.sent(uploads.due(account("ann")).single()))
        assertTrue(uploads.all(account("ann")).isEmpty())
    }

    @Test
    fun pagedFoldersAnswerTheFirstPageAndLoadTheRestInTheBackground() {
        api.page("2026", images = listOf("a.jpg"), next = "p2")
        api.page("2026", cursor = "p2", images = listOf("b.jpg"))
        val store = store()
        val first = store.children(folder)
        assertTrue(first.loading)
        assertEquals(listOf("a.jpg"), first.rows.map { it.name })
        assertEquals(1, loads.size)
        loads.removeFirst().run()
        val complete = store.children(folder)
        assertFalse(complete.loading)
        assertEquals(listOf("a.jpg", "b.jpg"), complete.rows.map { it.name })
        assertTrue(store.children(folder).loading)
    }

    @Test
    fun concurrentOpensOfOneFileDownloadItOnce() {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val downloads = AtomicInteger()
        api.download = { output ->
            downloads.incrementAndGet()
            started.countDown()
            release.await(10, TimeUnit.SECONDS)
            output.write(ByteArray(64) { 7 })
        }
        val cache = CloudOriginalCache(File(root, "originals"), CloudDocumentsApi(api))
        val stat = CloudFileStat(64, 1L)
        val pool = Executors.newFixedThreadPool(2)
        val opens =
            (1..2).map {
                pool.submit<Int> {
                    cache.open(file("a.bin"), stat, CancellationSignal()).let { descriptor ->
                        ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes().size }
                    }
                }
            }
        assertTrue(started.await(10, TimeUnit.SECONDS))
        Thread.sleep(100)
        release.countDown()
        assertEquals(listOf(64, 64), opens.map { it.get(10, TimeUnit.SECONDS) })
        assertEquals(1, downloads.get())
        pool.shutdown()
    }

    @Test
    fun aStagedReplacementFollowsItsFileThroughRenameAndDelete() {
        api.page("2026", files = listOf("notes.txt", "old.txt"))
        val store = store()
        store.children(folder)
        val notes = staged("notes.txt")
        writes(store).rename(file("notes.txt"), "renamed.txt")
        assertTrue(api.requests.any { it.startsWith("POST") && it.endsWith("/file/relocate") })
        assertEquals("2026/renamed.txt", uploads.all(account("ann")).single { it.token == notes.token }.path)

        staged("old.txt")
        writes(store).delete(file("old.txt"))
        assertTrue(api.requests.any { it.startsWith("DELETE") && it.contains("old.txt") })
        writes(store).schedule(server)
        assertEquals("Only the renamed file is sent; the trashed one stays gone", listOf("2026/renamed.txt"), api.uploads)
    }

    @Test
    fun anUnlistedStagedReplacementIsStillRenamedOnTheServer() {
        api.page("2026", files = listOf("notes.txt"))
        staged("notes.txt")
        // A fresh provider has no cached metadata: that does not mean the server lacks the file.
        writes(store()).rename(file("notes.txt"), "renamed.txt")
        assertTrue(api.requests.any { it.endsWith("/file/relocate") })
        assertEquals("2026/renamed.txt", uploads.all(account("ann")).single().path)
    }

    @Test
    fun aServerFileIsNotRenamedOntoANameOnlyWaitingToUpload() {
        api.page("2026", files = listOf("a.txt"))
        val store = store()
        store.children(folder)
        val waiting = ready("ann", "2026/b.txt")
        assertThrows(IllegalStateException::class.java) { writes(store).rename(file("a.txt"), "b.txt") }
        assertTrue("The server never sees the colliding rename", api.requests.none { it.endsWith("/file/relocate") })
        assertEquals("2026/b.txt", uploads.all(account("ann")).single { it.token == waiting.token }.path)
        writes(store).schedule(server)
        assertEquals(listOf("2026/b.txt"), api.uploads)
    }

    @Test
    fun aRejectedReplacementOfAServerFileShowsOnItsRow() {
        api.page("2026", files = listOf("notes.txt"))
        staged("notes.txt")
        api.status = { 413 }
        val store = store()
        writes(store).schedule(server)
        assertTrue(uploads.due(account("ann")).isEmpty())
        val listed = store.children(folder).rows.single()
        assertEquals("notes.txt", listed.name)
        assertTrue(listed.summary!!.startsWith("Not uploaded:"))
        assertTrue(writable(listed))
        assertTrue(store.row(file("notes.txt")).summary!!.startsWith("Not uploaded:"))
    }

    @Test
    fun renamingAFolderMovesTheDocumentsWaitingInIt() {
        api.page("2026")
        ready("ann", "2026/a.txt")
        writes(store()).rename(folder, "2027")
        assertTrue(api.requests.any { it.endsWith("/move") })
        assertEquals(listOf("2027/a.txt"), uploads.all(account("ann")).map { it.path })
    }

    @Test
    fun aFileIsNotRenamedOrTrashedWhileItsUploadIsInFlight() {
        api.page("2026", files = listOf("notes.txt"))
        val store = store()
        store.children(folder)
        val sending = uploads.claim(staged("notes.txt"))!!
        assertThrows(IllegalStateException::class.java) { writes(store).delete(file("notes.txt")) }
        assertThrows(IllegalStateException::class.java) { writes(store).rename(folder, "2027") }
        assertTrue(api.requests.none { it.startsWith("DELETE") || it.endsWith("/move") })
        uploads.release(sending)
        writes(store).delete(file("notes.txt"))
        assertTrue(uploads.all(account("ann")).isEmpty())
    }

    @Test
    fun aWriteCutShortByProcessDeathNeverUploads() {
        val torn = uploads.create(account("ann"), file("torn.txt"), writing = true)
        uploads.data(torn).writeText("half")
        uploads.data(torn).setLastModified(System.currentTimeMillis() - 2 * CloudPendingUploads.IDLE_MILLIS)
        val saved = ready("ann", "2026/saved.txt")
        uploads.opened(saved)
        // The provider process dies with both writers open.
        val restarted = CloudPendingUploads(File(root, "uploads"))
        assertTrue(restarted.due(account("ann")).isEmpty())
        assertEquals(
            listOf(CloudPendingUploads.INTERRUPTED, CloudPendingUploads.INTERRUPTED),
            restarted.all(account("ann")).map { it.failure },
        )
        restarted.closed(restarted.opened(restarted.find(account("ann"), file("saved.txt"))!!), clean = true)
        assertEquals(listOf(saved.token), restarted.due(account("ann")).map { it.token })
    }

    @Test
    fun readsPreferACompleteSaveOverTheServerCopy() {
        val replacing = uploads.create(account("ann"), file("notes.txt"), writing = true)
        assertFalse("A first writer is still copying the server's version", uploads.all(account("ann")).single().readable)
        uploads.closed(replacing, clean = true)
        assertTrue(uploads.find(account("ann"), file("notes.txt"))!!.readable)
        uploads.closed(uploads.opened(replacing), clean = false)
        assertFalse(uploads.find(account("ann"), file("notes.txt"))!!.readable)
    }

    @Test
    fun anUncachedFileResolvesInAFolderLargerThanTheMetadataCache() {
        api.page("2026", files = (0 until 4_200).map { "f$it.txt" })
        assertEquals(CloudEntryKind.File, store().entry(file("f0.txt")).kind)
    }

    private fun staged(name: String): CloudPendingUploads.Upload {
        val upload = uploads.create(account("ann"), file(name), writing = true)
        uploads.data(upload).writeText("edited $name")
        uploads.closed(upload, clean = true)
        return uploads.find(account("ann"), file(name))!!
    }

    private fun ready(user: String, path: String, age: Int = 0): CloudPendingUploads.Upload {
        val upload = uploads.create(account(user), folder.child(path.substringAfterLast('/'), false))
        uploads.data(upload).writeText(path)
        uploads.closed(uploads.opened(upload), clean = true)
        uploads.data(upload).setLastModified(System.currentTimeMillis() - age * 1000L)
        return upload
    }

    private fun account(user: String) = "https://maple.test#$user"

    private fun token(user: String): String {
        fun part(json: String) =
            Base64.encodeToString(json.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        return "${part("{\"alg\":\"HS256\"}")}.${part("{\"sub\":\"$user\"}")}.signature"
    }

    private class FakeServer : CloudTransport {
        val requests = mutableListOf<String>()
        val uploads = mutableListOf<String>()
        var status: (String) -> Int = { 201 }
        var download: (OutputStream) -> Unit = {}
        private val existing = mutableSetOf<String>()
        private val pages = mutableMapOf<String, JSONObject>()

        fun page(
            path: String,
            cursor: String? = null,
            images: List<String> = emptyList(),
            files: List<String> = emptyList(),
            next: String? = null,
        ) {
            existing += (images + files).map { "$path/$it" }
            fun entries(names: List<String>, indexed: Boolean) =
                JSONArray(
                    names.map { name ->
                        JSONObject()
                            .put("name", name)
                            .put("address", "photos:$path/$name")
                            .put("size", 10)
                            .put("mtime", "2026-01-01T00:00:00Z")
                            .apply { if (indexed) put("indexed", true).put("id", "a".repeat(24)) }
                    }
                )
            pages["/api/folder/photos/$path|${cursor.orEmpty()}"] =
                JSONObject()
                    .put("folders", JSONArray())
                    .put("images", entries(images, true))
                    .put("files", entries(files, false))
                    .put("sidecars", JSONArray())
                    .put("next_cursor", next ?: JSONObject.NULL)
        }

        override fun request(
            id: String,
            path: String,
            method: String,
            body: String?,
            headers: Map<String, String>,
        ): CloudResponse {
            synchronized(requests) { requests += "$method $path" }
            val uri = Uri.parse("https://maple.test$path")
            val page = pages["${uri.path}|${uri.getQueryParameter("cursor").orEmpty()}"]
            return when {
                page != null -> response(200, page)
                uri.path!!.endsWith("/file-meta") ->
                    if (uri.getQueryParameter("path") !in existing) response(404, JSONObject())
                    else response(200, JSONObject().put("size", 10).put("mtime", "2026-02-01T00:00:00Z"))
                method == "POST" && (uri.path!!.endsWith("/file/relocate") || uri.path!!.endsWith("/move")) ->
                    response(200, JSONObject())
                method == "DELETE" && uri.path!!.endsWith("/file") -> response(200, JSONObject())
                else -> response(404, JSONObject().put("error", "not found"))
            }
        }

        override fun download(id: String, path: String, output: OutputStream, signal: CancellationSignal?) =
            download(output)

        override fun upload(id: String, path: String, file: File, headers: Map<String, String>): CloudResponse {
            val target = Uri.decode(headers.getValue("X-Maple-Target-Path"))
            synchronized(uploads) { uploads += target }
            return response(status(target), JSONObject())
        }

        private fun response(status: Int, body: JSONObject) =
            CloudResponse(status, body.toString().toByteArray(), null, null)
    }
}
