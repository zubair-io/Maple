package app.justmaple.aperture

import app.justmaple.aperture.data.*
import java.io.File
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SharedCacheProviderTest {
    @Test
    fun aStableDocumentIdCannotPublishUnderItsOldBasenameAfterRename() = runBlocking {
        CacheProviderFixture().use { fixture ->
            val photo = fixture.library.list(fixture.root).photos.single()
            fixture.mode("renamed")
            assertTrue(runCatching { bytes(fixture.library, photo, 512) }.isFailure)
            assertNull(fixture.find(fixture.root, ".maple"))
            val renamed = fixture.library.list(fixture.root).photos.single()
            assertEquals(photo.uri, renamed.uri)
            assertEquals("renamed.dng", renamed.name)
            val image = bytes(fixture.library, renamed, 512)
            val thumbs = fixture.find(fixture.find(fixture.root, ".maple")!!, "thumbs")!!
            assertNull(fixture.find(thumbs, SharedCacheTier.Thumbnail.filename(photo.name)))
            assertArrayEquals(
                image,
                fixture.read(
                    fixture.find(thumbs, SharedCacheTier.Thumbnail.filename(renamed.name))!!
                ),
            )
            assertArrayEquals(fixture.original, fixture.read(renamed.uri))
        }
    }

    @Test
    fun hostedPreviewFallbackYieldsToNewerCanonicalAvifAndRejectsWrongIdentity() = runBlocking {
        CacheProviderFixture().use { fixture ->
            val photo = fixture.library.list(fixture.root).photos.single()
            val previews = fixture.directory(fixture.directory(fixture.root, ".maple"), "previews")
            val stem = photo.name
            val source = File.createTempFile("hosted-preview-", ".png", fixture.context.cacheDir)
            val encoded = File.createTempFile("hosted-preview-", ".jpg", fixture.context.cacheDir)
            try {
                source.writeBytes(fixture.asset("rgb-gradient.png"))
                NativeBridge.thumbnail(source.absolutePath, encoded.absolutePath, "", 1280)
                Thread.sleep(20)
                val jpeg = fixture.write(previews, "$stem.jpg", encoded.readBytes())
                val descriptor =
                    JSONObject()
                        .put("version", 1)
                        .put("format", "jpeg")
                        .put("mimeType", "image/jpeg")
                        .put(
                            "source",
                            JSONObject()
                                .put("size", photo.size)
                                .put("lastModified", photo.modified),
                        )
                        .put("artifactLastModified", fixture.modified(jpeg))
                val declaration =
                    fixture.write(
                        previews,
                        "$stem.preview.json",
                        descriptor.toString().toByteArray(),
                    )
                assertArrayEquals(encoded.readBytes(), bytes(fixture.library, photo, 2048))
                Thread.sleep(20)
                val avif = fixture.write(previews, "$stem.avif", fixture.asset("srgb-rgb.avif"))
                assertArrayEquals(
                    fixture.read(avif),
                    bytes(PhotoLibrary(fixture.context), photo, 2048),
                )
                descriptor.getJSONObject("source").put("size", photo.size + 1)
                fixture.resolver.openOutputStream(declaration, "wt")!!.use {
                    it.write(descriptor.toString().toByteArray())
                }
                val regenerated = bytes(fixture.library, photo, 2048)
                assertFalse(encoded.readBytes().contentEquals(regenerated))
                assertFalse(fixture.asset("srgb-rgb.avif").contentEquals(regenerated))
                assertArrayEquals(regenerated, fixture.read(fixture.find(previews, "$stem.avif")!!))
                assertNull(
                    "Obsolete Hosted bindings must not shadow a regenerated canonical AVIF",
                    fixture.find(previews, "$stem.preview.json"),
                )
                fixture.write(previews, "$stem.avif", fixture.asset("srgb-rgb.avif"))
                fixture.write(
                    previews,
                    "$stem.avif.source.json",
                    JSONObject()
                        .put("size", photo.size + 1)
                        .put("lastModified", photo.modified)
                        .toString()
                        .toByteArray(),
                )
                val repaired = bytes(fixture.library, photo, 2048)
                assertFalse(fixture.asset("srgb-rgb.avif").contentEquals(repaired))
                assertArrayEquals(repaired, fixture.read(fixture.find(previews, "$stem.avif")!!))
                assertNull(fixture.find(previews, "$stem.avif.source.json"))
                assertArrayEquals(fixture.original, fixture.read(photo.uri))
            } finally {
                source.delete()
                encoded.delete()
            }
        }
    }

    @Test
    fun legacyV25DerivativesAreRenamedIntoPlaceInsteadOfRegenerated() = runBlocking {
        CacheProviderFixture().use { fixture ->
            val photo = fixture.library.list(fixture.root).photos.single()
            val maple = fixture.directory(fixture.root, ".maple")
            val thumbs = fixture.directory(maple, "thumbs")
            val previews = fixture.directory(maple, "previews")
            Thread.sleep(20)
            val sharedBytes = fixture.asset("srgb-rgb.avif")
            for ((directory, tier) in
                listOf(thumbs to SharedCacheTier.Thumbnail, previews to SharedCacheTier.Preview))
                fixture.write(directory, tier.legacyFilename(photo.name), sharedBytes)
            assertArrayEquals(sharedBytes, bytes(fixture.library, photo, 512))
            assertArrayEquals(sharedBytes, bytes(fixture.library, photo, 2048))
            for ((directory, tier) in
                listOf(thumbs to SharedCacheTier.Thumbnail, previews to SharedCacheTier.Preview)) {
                assertEquals(
                    listOf(tier.filename(photo.name)),
                    fixture.children(directory).map { it.second },
                )
                assertArrayEquals(
                    sharedBytes,
                    fixture.read(fixture.find(directory, tier.filename(photo.name))!!),
                )
            }
            assertArrayEquals(fixture.original, fixture.read(photo.uri))
        }
    }

    @Test
    fun readOnlyFoldersServeLegacyV25DerivativesInPlace() = runBlocking {
        CacheProviderFixture().use { fixture ->
            val photo = fixture.library.list(fixture.root).photos.single()
            val thumbs = fixture.directory(fixture.directory(fixture.root, ".maple"), "thumbs")
            Thread.sleep(20)
            val sharedBytes = fixture.asset("srgb-rgb.avif")
            val legacyName = SharedCacheTier.Thumbnail.legacyFilename(photo.name)
            fixture.write(thumbs, legacyName, sharedBytes)
            fixture.mode("readOnly")
            assertArrayEquals(sharedBytes, bytes(fixture.library, photo, 512))
            assertEquals(listOf(legacyName), fixture.children(thumbs).map { it.second })
            assertArrayEquals(fixture.original, fixture.read(photo.uri))
        }
    }

    @Test
    fun concurrentLibrariesPublishOneCompleteSharedImage() = runBlocking {
        CacheProviderFixture().use { fixture ->
            val photo = fixture.library.list(fixture.root).photos.single()
            val results =
                List(2) {
                        async(Dispatchers.IO) { bytes(PhotoLibrary(fixture.context), photo, 512) }
                    }
                    .awaitAll()
            assertArrayEquals(results[0], results[1])
            val thumbs = fixture.find(fixture.find(fixture.root, ".maple")!!, "thumbs")!!
            val entries = fixture.children(thumbs)
            assertEquals(1, entries.size)
            assertEquals(SharedCacheTier.Thumbnail.filename(photo.name), entries.single().second)
            assertArrayEquals(results[0], fixture.read(entries.single().first))
            assertArrayEquals(fixture.original, fixture.read(photo.uri))
        }
    }

    @Test
    fun cancellationDuringProviderWriteLeavesNoCanonicalOrPartialImage() = runBlocking {
        CacheProviderFixture().use { fixture ->
            val photo = fixture.library.list(fixture.root).photos.single()
            fixture.mode("pausePublication")
            val job = launch(Dispatchers.IO) { bytes(fixture.library, photo, 512) }
            try {
                fixture.awaitBlocked()
                job.cancel()
            } finally {
                fixture.call("cache-test-release")
                job.join()
            }
            assertTrue(job.isCancelled)
            val thumbs = fixture.find(fixture.find(fixture.root, ".maple")!!, "thumbs")!!
            assertTrue(fixture.children(thumbs).isEmpty())
            assertArrayEquals(fixture.original, fixture.read(photo.uri))
        }
    }

    @Test
    fun externalXmpChangeDuringPublicationDiscardsTheOldRenderAndRetries() = runBlocking {
        CacheProviderFixture().use { fixture ->
            val photo = fixture.library.list(fixture.root).photos.single()
            val baseline = bytes(fixture.library, photo, 512)
            fixture.write(
                fixture.root,
                "photo.xmp",
                XmpDocument().withAttribute("crs:Exposure2012", "0.25").serialize().toByteArray(),
            )
            fixture.mode("pausePublication")
            val read = async(Dispatchers.IO) { bytes(fixture.library, photo, 512) }
            val finalXml =
                XmpDocument().withAttribute("crs:Exposure2012", "1.25").serialize().toByteArray()
            try {
                fixture.awaitBlocked()
                fixture.write(fixture.root, "photo.xmp", finalXml)
            } finally {
                fixture.call("cache-test-release")
            }
            val current = read.await()
            assertFalse(baseline.contentEquals(current))
            val thumbs = fixture.find(fixture.find(fixture.root, ".maple")!!, "thumbs")!!
            assertArrayEquals(
                current,
                fixture.read(
                    fixture.find(thumbs, SharedCacheTier.Thumbnail.filename(photo.name))!!
                ),
            )
            assertArrayEquals(finalXml, fixture.read(fixture.find(fixture.root, "photo.xmp")!!))
            assertArrayEquals(fixture.original, fixture.read(photo.uri))
        }
    }

    private suspend fun bytes(library: PhotoLibrary, photo: Photo, edge: Int) =
        library.withThumbnail(photo, edge) { _, input -> input.readBytes() }
}
