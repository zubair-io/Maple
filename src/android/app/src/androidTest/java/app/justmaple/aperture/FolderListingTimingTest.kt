package app.justmaple.aperture

import android.graphics.BitmapFactory
import android.provider.DocumentsContract
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.*
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@TimingBenchmark
@RunWith(AndroidJUnit4::class)
class FolderListingTimingTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun warmTilesInFoldersOf200And2000Photos() {
        for (count in listOf(200, 2_000)) measure(count)
    }

    private fun load(library: PhotoLibrary, photo: Photo) = runBlocking {
        library.withThumbnail(photo, 512) { _, input -> BitmapFactory.decodeFileDescriptor(input.fd)!!.recycle() }
    }

    private fun spread(rounds: List<TimingFolders.Counters>) =
        listOf<Pair<String, (TimingFolders.Counters) -> Int>>(
                "listings" to { it.childQueries },
                "rows" to { it.childRows },
                "documentQueries" to { it.documentQueries },
                "sidecarReads" to { it.sidecarReads },
            )
            .joinToString(" ") { (name, field) ->
                val values = rounds.map(field)
                "$name=min ${values.min()} max ${values.max()}"
            }

    private fun measure(count: Int) {
        val folders = TimingFolders()
        try {
            val directory = folders.populate("", count)
            val library = PhotoLibrary(context)
            val folder = DocumentsContract.buildDocumentUriUsingTree(folders.tree, "root")
            val photos = runBlocking { library.list(folder) }.photos
            assertEquals(count + 1, photos.size)
            val firstName = "IMG_00001.dng"
            load(library, photos.first { it.name == firstName })
            val thumbs = File(directory, ".maple/thumbs")
            val seed = File(thumbs, "$firstName.avif")
            val warmAt = System.currentTimeMillis()
            for (photo in photos) File(thumbs, "${photo.name}.avif").also {
                if (!it.exists()) seed.copyTo(it)
                it.setLastModified(warmAt)
            }
            val tiles = photos.filter { it.name != "photo.dng" }
            val label = "folder-$count"
            Timing.fact("$label.setup", "photos=${photos.size} thumbnails=${thumbs.listFiles()!!.size}")

            load(library, tiles.last())
            val tileMillis = mutableListOf<Double>()
            val perTile = mutableListOf<TimingFolders.Counters>()
            repeat(Timing.rounds) { round ->
                val photo = tiles[(round * 37) % tiles.size]
                val thumbnail = File(thumbs, "${photo.name}.avif")
                val before = folders.counters()
                tileMillis += Timing.millis { load(library, photo) }.second
                perTile += folders.counters() - before
                assertEquals("A warm tile must not rewrite its thumbnail", warmAt, thumbnail.lastModified())
            }
            Timing.fact("$label.warm-tile.provider-calls", "rounds=${perTile.size} ${spread(perTile)} byFolder=${perTile.map { it.byParent }.distinct()}")
            Timing.report("$label.warm-tile", "ms", tileMillis, "withThumbnail plus decodeFileDescriptor for one tile that scrolled into view")

            tiles.takeLast(30).forEach { load(library, it) }
            val screenfuls = mutableListOf<Double>()
            val perScreenful = mutableListOf<TimingFolders.Counters>()
            repeat(Timing.rounds) { round ->
                val screenful = List(30) { tiles[(round * 53 + it) % tiles.size] }
                val before = folders.counters()
                screenfuls += Timing.millis { screenful.forEach { load(library, it) } }.second
                perScreenful += folders.counters() - before
            }
            Timing.fact("$label.screenful-of-30.provider-calls", "rounds=${perScreenful.size} ${spread(perScreenful)}")
            Timing.report("$label.screenful-of-30", "ms", screenfuls, "30 warm tiles loaded one after another, as the grid's tile effects serialise on one lock")
        } finally {
            folders.fixture.close()
        }
    }
}
