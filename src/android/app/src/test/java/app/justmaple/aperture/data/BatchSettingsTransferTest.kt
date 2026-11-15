package app.justmaple.aperture.data

import android.content.ContextWrapper
import android.net.Uri
import app.justmaple.aperture.generated.AdjustmentTransfer
import java.io.File
import java.io.IOException
import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class BatchSettingsTransferTest {
    private val folder = Files.createTempDirectory("maple-batch-paste-").toFile()
    private val context = object : ContextWrapper(RuntimeEnvironment.getApplication()) {
        override fun getFilesDir() = File(folder, "files").apply { mkdirs() }
        override fun getCacheDir() = File(folder, "cache").apply { mkdirs() }
    }
    private val library = PhotoLibrary(context)
    private val ledger = File(context.filesDir, "batch-settings-transfer.json")
    private val tone = AdjustmentTransfer.groups.single { it.id == "tone" }
    private val detail = AdjustmentTransfer.groups.single { it.id == "detail" }
    private val geometry = AdjustmentTransfer.groups.single { it.id == "geometry" }

    @After fun tearDown() { folder.deleteRecursively() }

    private fun queue(
        load: suspend (Photo) -> LoadedSidecar = library::loadSidecar,
        save: suspend (Photo, XmpDocument, String?) -> LoadedSidecar = library::save,
    ) = BatchSettingsTransfer(ledger, load, save)

    private fun photo(name: String): Photo {
        val original = File(folder, name).apply { writeText("immutable original $name") }
        return Photo(Uri.fromFile(original), name, original.length(), original.lastModified(), null)
    }

    private fun document(vararg attributes: Pair<String, String>): XmpDocument =
        attributes.fold(XmpDocument()) { doc, (key, value) -> doc.withAttribute(key, value) }

    private val copied get() = CopiedSettings("source.dng", document("crs:Exposure2012" to "1.25"))

    private suspend fun seed(photo: Photo, document: XmpDocument = document("crs:Exposure2012" to "-0.5")) {
        library.save(photo, document, null)
    }

    private suspend fun edit(photo: Photo, key: String, value: String) {
        val current = library.loadSidecar(photo)
        library.save(photo, current.document.withAttribute(key, value), current.baseline)
    }

    private suspend fun attribute(photo: Photo, key: String): String? = library.loadSidecar(photo).document.attribute(key)

    private class Crash : Error()

    private suspend fun crash(action: suspend () -> Unit) {
        try { action(); fail("Expected an interrupted process") } catch (_: Crash) { }
    }

    @Test fun plannerCopiesOnlySelectedGroupsAndSkipsRasterRestrictedFieldsThroughRealSidecars() = runBlocking {
        val raw = photo("raw.dng")
        val jpeg = photo("raster.JPG")
        val body = "<f:keep>foreign bytes &amp; more</f:keep><crs:RetouchAreas><rdf:Seq><rdf:li>target repair</rdf:li></rdf:Seq></crs:RetouchAreas>"
        val target = XmpDocument("""<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:f="urn:foreign"
            crs:Exposure2012="-0.5" crs:Contrast2012="-10" crs:Whites2012="-20" crs:Highlights2012="25"
            crs:Saturation="10" crs:Temperature="6200" papp:CaptureSharpeningAmount="8">$body</rdf:Description>
        </rdf:RDF>""")
        seed(raw, target)
        seed(jpeg, target)
        val curve = listOf(CurveKnot(0f, 0f), CurveKnot(0.5f, 0.75f), CurveKnot(1f, 1f))
        val source = CopiedSettings("source.dng", document(
            "crs:Exposure2012" to "1.25", "crs:Contrast2012" to "30", "crs:Whites2012" to "50",
            "crs:Saturation" to "-30", "crs:Temperature" to "4800", "crs:Sharpness" to "60",
            "papp:CaptureSharpeningAmount" to "40", "crs:HasCrop" to "True", "crs:CropTop" to "0.1",
        ).withCurve(PointCurve.byElement.getValue("papp:SceneLinearToneCurve"), curve))
        val batch = queue()
        batch.prepare(listOf(raw, jpeg, raw), source, listOf(tone, detail, geometry))
        assertTrue(ledger.isFile)
        assertEquals(2, batch.state.value.pending)
        assertEquals(0, batch.state.value.completed)
        assertEquals("-0.5", attribute(raw, "crs:Exposure2012"))
        batch.run()
        assertEquals(2, batch.state.value.completed)
        assertEquals(0, batch.state.value.failed)
        assertTrue(isRawTransferTarget(raw))
        assertFalse(isRawTransferTarget(jpeg))
        for (photo in listOf(raw, jpeg)) {
            val written = library.loadSidecar(photo).document
            assertEquals("1.25", written.attribute("crs:Exposure2012"))
            assertNull(written.attribute("crs:Highlights2012"))
            assertEquals("10", written.attribute("crs:Saturation"))
            assertEquals("6200", written.attribute("crs:Temperature"))
            assertEquals("60", written.attribute("crs:Sharpness"))
            assertEquals("0.1", written.attribute("crs:CropTop"))
            assertTrue(written.original.contains(body))
            assertEquals("immutable original ${photo.name}", File(photo.uri.path!!).readText())
            assertEquals(3, written.curve(PointCurve.byElement.getValue("papp:SceneLinearToneCurve")).size)
        }
        assertEquals("30", attribute(raw, "crs:Contrast2012"))
        assertEquals("50", attribute(raw, "crs:Whites2012"))
        assertEquals("40", attribute(raw, "papp:CaptureSharpeningAmount"))
        assertEquals("-10", attribute(jpeg, "crs:Contrast2012"))
        assertEquals("-20", attribute(jpeg, "crs:Whites2012"))
        assertEquals("8", attribute(jpeg, "papp:CaptureSharpeningAmount"))
        assertEquals(2, BatchSettingsTransfer(context, PhotoLibrary(context)).state.value.completed)
    }

    @Test fun reloadKeepsFrozenSparseValuesAndPreservesUnselectedNewerEdits() = runBlocking {
        val source = photo("source.dng")
        val target = photo("target.dng")
        seed(source, document("crs:Exposure2012" to "1.25"))
        seed(target, document("crs:Exposure2012" to "-0.5", "crs:Contrast2012" to "12"))
        val fields = mutableListOf("exposure")
        queue().prepare(listOf(target), CopiedSettings(source.name, library.loadSidecar(source).document), listOf(tone.copy(fields = fields)))
        fields.clear()
        edit(source, "crs:Exposure2012", "7")
        edit(target, "crs:Saturation", "33")
        edit(target, "xmp:Rating", "5")
        val recovered = queue()
        recovered.run()
        assertEquals(1, recovered.state.value.completed)
        assertEquals("1.25", attribute(target, "crs:Exposure2012"))
        assertEquals("12", attribute(target, "crs:Contrast2012"))
        assertEquals("33", attribute(target, "crs:Saturation"))
        assertEquals("5", attribute(target, "xmp:Rating"))
    }

    @Test fun conflictingSelectedEditsFailByPhotoWithoutStoppingOtherTargetsOrBeingRebasedOnRetry() = runBlocking {
        val changed = photo("changed.dng")
        val unchanged = photo("unchanged.dng")
        seed(changed)
        seed(unchanged)
        val batch = queue()
        batch.prepare(listOf(changed, unchanged), copied, listOf(tone))
        edit(changed, "crs:Exposure2012", "8")
        batch.run()
        assertEquals(1, batch.state.value.completed)
        assertEquals(1, batch.state.value.failed)
        val failure = queue().state.value.entries.single { it.error != null }
        assertEquals("changed.dng", failure.photo.name)
        assertTrue(failure.error!!.contains("newer edits"))
        batch.run(retryFailed = true)
        assertEquals(1, batch.state.value.failed)
        assertEquals("8", attribute(changed, "crs:Exposure2012"))
        assertEquals("1.25", attribute(unchanged, "crs:Exposure2012"))
    }

    @Test fun crashBeforeWriteRecoversPreparedPatchAndMissingSidecar() = runBlocking {
        val target = photo("missing.dng")
        val batch = queue(save = { _, _, _ -> throw Crash() })
        batch.prepare(listOf(target), copied, listOf(tone))
        crash { batch.run() }
        assertEquals(0, batch.state.value.completed)
        assertNull(library.loadSidecar(target).baseline)
        val recovered = queue()
        assertEquals(BatchPasteStatus.Prepared, recovered.state.value.entries.single().status)
        recovered.run()
        assertEquals(1, recovered.state.value.completed)
        assertEquals("1.25", attribute(target, "crs:Exposure2012"))
    }

    @Test fun crashAfterWriteRecognizesExactPatchWithoutRewritingUnrelatedNewerEdits() = runBlocking {
        val target = photo("written.dng")
        seed(target)
        val batch = queue(save = { photo, document, baseline ->
            library.save(photo, document, baseline)
            throw Crash()
        })
        batch.prepare(listOf(target), copied, listOf(tone))
        crash { batch.run() }
        assertEquals(0, batch.state.value.completed)
        edit(target, "xmp:Rating", "4")
        var writes = 0
        val recovered = queue(save = { photo, document, baseline ->
            writes++
            library.save(photo, document, baseline)
        })
        recovered.run()
        assertEquals(1, recovered.state.value.completed)
        assertEquals(0, writes)
        assertEquals("4", attribute(target, "xmp:Rating"))
    }

    @Test fun crashAfterWriteNeverReplacesAnInterveningSelectedEdit() = runBlocking {
        val target = photo("newer.dng")
        seed(target)
        val batch = queue(save = { photo, document, baseline ->
            library.save(photo, document, baseline)
            throw Crash()
        })
        batch.prepare(listOf(target), copied, listOf(tone))
        crash { batch.run() }
        edit(target, "crs:Exposure2012", "9")
        val recovered = queue()
        recovered.run()
        assertEquals(0, recovered.state.value.completed)
        assertEquals(1, recovered.state.value.failed)
        assertEquals("9", attribute(target, "crs:Exposure2012"))
    }

    @Test fun cancelStopsAfterConfirmedInflightWriteAndReloadResumesPendingOnly() = runBlocking {
        val photos = listOf(photo("first.dng"), photo("second.dng"), photo("third.dng"))
        photos.forEach { seed(it) }
        lateinit var batch: BatchSettingsTransfer
        var writes = 0
        batch = queue(save = { photo, document, baseline ->
            assertTrue(batch.state.value.running)
            assertEquals(0, batch.state.value.completed)
            val saved = library.save(photo, document, baseline)
            writes++
            batch.cancel()
            saved
        })
        batch.prepare(photos, copied, listOf(tone))
        batch.run()
        assertEquals(1, writes)
        assertFalse(batch.state.value.running)
        assertEquals(1, batch.state.value.completed)
        assertEquals(2, batch.state.value.pending)
        assertEquals("-0.5", attribute(photos[1], "crs:Exposure2012"))
        edit(photos.first(), "crs:Exposure2012", "6")
        val recovered = queue()
        recovered.run()
        assertEquals(3, recovered.state.value.completed)
        assertEquals("6", attribute(photos.first(), "crs:Exposure2012"))
        assertEquals("1.25", attribute(photos.last(), "crs:Exposure2012"))
    }

    @Test fun retryFailedTouchesNeitherAppliedNorPendingPhotos() = runBlocking {
        val photos = listOf(photo("applied.dng"), photo("failed.dng"), photo("pending.dng"))
        photos.forEach { seed(it) }
        lateinit var batch: BatchSettingsTransfer
        batch = queue(save = { photo, document, baseline ->
            if (photo == photos[1]) {
                batch.cancel()
                throw IOException("Storage disconnected")
            }
            library.save(photo, document, baseline)
        })
        batch.prepare(photos, copied, listOf(tone))
        batch.run()
        assertEquals(1, batch.state.value.completed)
        assertEquals(1, batch.state.value.failed)
        assertEquals(1, batch.state.value.pending)
        edit(photos.first(), "crs:Exposure2012", "7")
        val recovered = queue()
        assertEquals("Storage disconnected", recovered.state.value.entries[1].error)
        recovered.run(retryFailed = true)
        assertEquals(2, recovered.state.value.completed)
        assertEquals(1, recovered.state.value.pending)
        assertEquals(0, recovered.state.value.failed)
        assertEquals("7", attribute(photos.first(), "crs:Exposure2012"))
        assertEquals("-0.5", attribute(photos.last(), "crs:Exposure2012"))
        recovered.run()
        assertEquals(3, recovered.state.value.completed)
    }

    @Test fun unreadableTargetHasPersistentNamedFailureAndCanBePlannedOnRetry() = runBlocking {
        val unavailable = photo("unavailable.dng")
        val available = photo("available.dng")
        seed(unavailable)
        seed(available)
        val batch = queue(load = { photo ->
            if (photo == unavailable) throw IOException("Read permission revoked")
            library.loadSidecar(photo)
        })
        batch.prepare(listOf(unavailable, available), copied, listOf(tone))
        batch.run()
        assertEquals(1, batch.state.value.completed)
        val recovered = queue()
        assertEquals("unavailable.dng", recovered.state.value.entries.single { it.error != null }.photo.name)
        assertEquals("Read permission revoked", recovered.state.value.entries.first().error)
        recovered.run(retryFailed = true)
        assertEquals(2, recovered.state.value.completed)
        assertEquals("1.25", attribute(unavailable, "crs:Exposure2012"))
    }

    @Test fun conditionalBaselineRefusesAChangeBetweenLoadAndWrite() = runBlocking {
        val target = photo("race.dng")
        seed(target)
        val batch = queue(save = { photo, document, baseline ->
            edit(photo, "crs:Exposure2012", "8")
            library.save(photo, document, baseline)
        })
        batch.prepare(listOf(target), copied, listOf(tone))
        batch.run()
        assertEquals(0, batch.state.value.completed)
        assertEquals(1, batch.state.value.failed)
        assertTrue(batch.state.value.entries.single().error!!.contains("sidecar changed"))
        assertEquals("8", attribute(target, "crs:Exposure2012"))
    }

    @Test fun progressRequiresReadBackRatherThanTrustingSaveReturnValue() = runBlocking {
        val target = photo("unconfirmed.dng")
        seed(target)
        val batch = queue(save = { photo, document, baseline ->
            val saved = library.save(photo, document, baseline)
            edit(photo, "crs:Exposure2012", "9")
            saved
        })
        batch.prepare(listOf(target), copied, listOf(tone))
        batch.run()
        assertEquals(0, batch.state.value.completed)
        assertEquals(1, batch.state.value.failed)
        assertTrue(batch.state.value.entries.single().error!!.contains("confirm"))
        assertEquals("9", attribute(target, "crs:Exposure2012"))
    }

    @Test fun scopeCancellationStillCommitsTheInflightWriteAndLeavesOtherEntriesPending() = runBlocking {
        val photos = listOf(photo("inflight.dng"), photo("waiting.dng"))
        photos.forEach { seed(it) }
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val batch = queue(save = { photo, document, baseline ->
            started.complete(Unit)
            release.await()
            library.save(photo, document, baseline)
        })
        batch.prepare(photos, copied, listOf(tone))
        val task = launch(Dispatchers.Default) { batch.run() }
        started.await()
        task.cancel()
        release.complete(Unit)
        task.join()
        assertFalse(batch.state.value.running)
        assertEquals(1, batch.state.value.completed)
        assertEquals(1, batch.state.value.pending)
        val recovered = queue()
        recovered.run()
        assertEquals(2, recovered.state.value.completed)
    }

    @Test fun preparingCannotReplaceAnUnfinishedJobButCanReplaceACompletedJob() = runBlocking {
        val first = photo("first.dng")
        val second = photo("second.dng")
        val batch = queue()
        assertFalse(batch.hasJob)
        batch.prepare(listOf(first), copied, listOf(tone))
        try {
            batch.prepare(listOf(second), copied, listOf(tone))
            fail("Unfinished queue was replaced")
        } catch (_: IllegalStateException) { }
        assertEquals(first, batch.state.value.entries.single().photo)
        batch.run()
        batch.prepare(listOf(second), copied, listOf(tone))
        assertTrue(batch.state.value.hasJob)
        assertEquals(second, batch.state.value.entries.single().photo)
    }

    @Test fun cancelDuringPreparationSkipsInitialRunButAllowsExplicitResume() = runBlocking {
        val photos = listOf(photo("first.dng"), photo("second.dng"))
        lateinit var batch: BatchSettingsTransfer
        batch = queue(load = { photo ->
            if (!batch.hasJob) batch.cancel()
            library.loadSidecar(photo)
        })
        batch.prepare(photos, copied, listOf(tone))
        batch.run()
        assertEquals(0, batch.state.value.completed)
        assertEquals(2, batch.state.value.pending)
        assertNull(library.loadSidecar(photos.first()).baseline)
        batch.run()
        assertEquals(2, batch.state.value.completed)
    }

    @Test fun discardingFailureClearsDurableQueueAndAllowsAnotherPaste() = runBlocking {
        val target = photo("conflict.dng")
        seed(target)
        val batch = queue()
        batch.prepare(listOf(target), copied, listOf(tone))
        edit(target, "crs:Exposure2012", "9")
        batch.run()
        assertEquals(1, batch.state.value.failed)
        batch.discard()
        assertFalse(ledger.exists())
        assertFalse(batch.state.value.hasJob)
        assertFalse(queue().hasJob)
        batch.prepare(listOf(target), copied, listOf(tone))
        batch.run()
        assertEquals(1, batch.state.value.completed)
    }

    @Test fun completedPhotoRevisionIsStableAcrossRecoveryAndChangesForANewBatch() = runBlocking {
        val target = photo("revision.dng")
        seed(target)
        val batch = queue()
        batch.prepare(listOf(target), copied, listOf(tone))
        val first = batch.state.value.jobId
        assertNotNull(first)
        batch.run()
        assertEquals(first, batch.state.value.jobId)
        assertEquals(first, queue().state.value.jobId)
        batch.prepare(listOf(target), CopiedSettings("next.dng", document("crs:Exposure2012" to "2")), listOf(tone))
        assertNotEquals(first, batch.state.value.jobId)
        batch.run()
        assertEquals("2", attribute(target, "crs:Exposure2012"))
    }
}
