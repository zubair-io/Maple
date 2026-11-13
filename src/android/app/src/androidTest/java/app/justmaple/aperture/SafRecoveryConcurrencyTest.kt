package app.justmaple.aperture

import android.os.Bundle
import android.provider.DocumentsContract
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.data.XmpEncoding
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Two real library instances must not consume the same on-disk transaction. */
class SafRecoveryConcurrencyTest {
    @Test
    fun concurrentRecoveryBeforePublicationPreservesThePreviousSidecar() = runBlocking {
        recoverWithCompetingReader(published = false)
    }

    @Test
    fun concurrentRecoveryAfterPublicationPreservesThePublishedSidecar() = runBlocking {
        recoverWithCompetingReader(published = true)
    }

    private suspend fun recoverWithCompetingReader(published: Boolean) = coroutineScope {
        CacheProviderFixture().use { fixture ->
            val photo = fixture.library.list(fixture.root).photos.single()
            val baseline = XmpDocument().withAttribute("xmp:Label", "Previous").serialize()
            val replacement = XmpDocument(baseline).withAttribute("xmp:Label", "Published").serialize()
            val canonical = fixture.write(fixture.root, photo.sidecarName, XmpEncoding.encode(baseline))
            val id = UUID.randomUUID().toString()
            val tempName = ".maple-$id.xmp"
            val backupName = ".maple-$id.backup.xmp"
            val temp = fixture.write(fixture.root, tempName, XmpEncoding.encode(replacement))
            DocumentsContract.renameDocument(fixture.resolver, canonical, backupName)!!
            if (published) DocumentsContract.renameDocument(fixture.resolver, temp, photo.sidecarName)!!
            val journal = File(
                File(fixture.context.filesDir, "sidecar-transactions").apply { mkdirs() },
                PhotoLibrary.digest(photo.uri.toString()) + ".json",
            )
            journal.writeText(
                JSONObject()
                    .put("id", id)
                    .put("folder", fixture.root.toString())
                    .put("target", photo.sidecarName)
                    .put("temp", tempName)
                    .put("backup", backupName)
                    .put("previous", true)
                    .put("digest", PhotoLibrary.digest(replacement))
                    .put("baseline", PhotoLibrary.digest(baseline))
                    .toString()
            )
            fixture.call("cache-test-mode", Bundle().apply {
                putString("pauseSidecarRead", if (published) photo.sidecarName else backupName)
            })
            try {
                val first = async(Dispatchers.IO) {
                    runCatching { fixture.library.loadSidecar(photo) }
                }
                fixture.awaitBlocked()
                // Start the second caller through its first suspension. Its read
                // must wait while the first owns the shared recovery transaction.
                val second = async(start = CoroutineStart.UNDISPATCHED) {
                    runCatching { PhotoLibrary(fixture.context).loadSidecar(photo) }
                }
                val early = try {
                    withTimeoutOrNull(1_000) { second.await() }
                } finally {
                    fixture.call("cache-test-release")
                }
                val results = withTimeout(10_000) { listOf(first.await(), second.await()) }
                val expected = if (published) replacement else baseline
                results.forEach { assertEquals(expected, it.getOrThrow().baseline) }
                assertNull("A competing library consumed the in-flight transaction", early)
                assertFalse(journal.exists())
                assertEquals(
                    setOf(photo.name, photo.sidecarName),
                    fixture.children(fixture.root).map { it.second }.toSet(),
                )
                assertArrayEquals(fixture.original, fixture.read(photo.uri))
                // A stale editor must still be rejected after serialized recovery.
                val secondLibrary = PhotoLibrary(fixture.context)
                val external = XmpDocument(expected).withAttribute("xmp:Label", "External edit").serialize()
                fixture.write(fixture.root, photo.sidecarName, XmpEncoding.encode(external))
                assertTrue(runCatching {
                    secondLibrary.save(photo, XmpDocument(expected), expected)
                }.isFailure)
                assertEquals(external, secondLibrary.loadSidecar(photo).baseline)
                assertArrayEquals(fixture.original, fixture.read(photo.uri))
            } finally {
                fixture.call("cache-test-release")
                journal.delete()
            }
        }
    }
}
