package app.justmaple.aperture.data

import android.content.Context
import android.provider.DocumentsContract
import app.justmaple.aperture.data.CountingTree.Companion.AUTHORITY
import app.justmaple.aperture.data.CountingTree.Companion.directory
import app.justmaple.aperture.data.CountingTree.Companion.failDeletes
import app.justmaple.aperture.data.CountingTree.Companion.folder
import java.io.File
import java.nio.file.Files
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** A recovery that renames sidecars and then fails still tells the tile listing the folder changed. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SidecarRecoveryListingTest {
    private val context: Context = RuntimeEnvironment.getApplication()
    private val journals = File(context.filesDir, "sidecar-transactions")
    private val edited = XmpDocument().withAttribute("xmp:Rating", "4").serialize()
    private val staged = XmpDocument().withAttribute("xmp:Rating", "5").serialize()
    private val id = UUID.randomUUID().toString()

    @Before
    fun interruptedBetweenTheTwoRenames() {
        directory = Files.createTempDirectory("recovery-listing").toFile()
        Robolectric.setupContentProvider(CountingTree::class.java, AUTHORITY)
        CountingTree.reportsModified = true
        File(directory, "IMG_1.dng").writeBytes(ByteArray(8))
        File(directory, ".maple-$id.backup.xmp").writeBytes(XmpEncoding.encode(edited))
        File(directory, ".maple-$id.xmp").writeBytes(XmpEncoding.encode(staged))
        journals.mkdirs()
    }

    @After
    fun cleanUp() {
        failDeletes = false
        directory.deleteRecursively()
        journals.deleteRecursively()
    }

    @Test
    fun aRecoveryThatFailsAfterRestoringTheSidecarLeavesNoStaleListing() {
        val library = PhotoLibrary(context) { 0L }
        val photo = runBlocking { library.list(folder) }.photos.single()
        File(journals, PhotoLibrary.digest(photo.uri.toString()) + ".json")
            .writeText(
                JSONObject()
                    .put("id", id)
                    .put("folder", folder.toString())
                    .put("target", "IMG_1.xmp")
                    .put("temp", ".maple-$id.xmp")
                    .put("backup", ".maple-$id.backup.xmp")
                    .put("previous", true)
                    .put("digest", PhotoLibrary.digest(staged))
                    .put("baseline", PhotoLibrary.digest(edited))
                    .toString()
            )
        assertTrue(library.local.recent(folder).none { it.name == "IMG_1.xmp" })
        failDeletes = true

        assertThrows(IllegalStateException::class.java) { runBlocking { library.loadSidecar(photo) } }

        assertTrue(File(directory, "IMG_1.xmp").isFile)
        assertTrue(library.local.recent(folder).any { it.name == "IMG_1.xmp" })
    }
}
