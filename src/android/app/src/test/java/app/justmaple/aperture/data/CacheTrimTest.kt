package app.justmaple.aperture.data

import java.io.File
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CacheTrimTest {
    @get:Rule val temporary = TemporaryFolder()

    private fun hex(seed: String) =
        MessageDigest.getInstance("SHA-256").digest(seed.toByteArray()).joinToString("") {
            "%02x".format(it)
        }

    private fun cloudEntry(folder: File, index: Int, payloadBytes: Int, age: Long): List<File> {
        val key = hex("key-$index")
        val content = hex("content-$index")
        val indexFile = File(folder, "cloud-$key.json")
        indexFile.writeText("""{"content":"$content","etag":"e$index"}""")
        val payload = File(folder, "cloud-$key-$content.avif")
        payload.writeBytes(ByteArray(payloadBytes))
        val stamp = 1_700_000_000_000L - age * 1000
        indexFile.setLastModified(stamp)
        payload.setLastModified(stamp)
        return listOf(indexFile, payload)
    }

    private fun pngOf(folder: File, entry: List<File>, bytes: Int): File {
        val png = File(folder, "png-${entry[1].nameWithoutExtension}.png")
        png.writeBytes(ByteArray(bytes))
        png.setLastModified(entry[1].lastModified() - 400)
        return png
    }

    @Test
    fun aLegacyPngIsEvictedAndKeptWithItsIndexAndPayload() {
        val folder = temporary.newFolder()
        val entries = (0 until 12).map { cloudEntry(folder, it, 1000, it.toLong()) }
        val pngs = entries.map { pngOf(folder, it, 300) }
        val whole = entries.mapIndexed { index, entry -> entry + pngs[index] }

        trimCache(folder, 5L * 1400, keep = setOf(pngs.last()))

        val present = whole.map { group -> group.count { it.isFile } }
        assertTrue("no entry loses only some of its files: $present", present.all { it == 0 || it == 3 })
        assertTrue("the kept PNG keeps its whole entry", whole.last().all { it.isFile })
        assertTrue("the newest entry survives", whole.first().all { it.isFile })
        assertTrue("older entries went", present.count { it == 3 } in 2..5)
    }

    @Test
    fun aCacheWithinItsBudgetLosesNothing() {
        val folder = temporary.newFolder()
        val entries = (0 until 200).map { cloudEntry(folder, it, 1024, it.toLong()) }
        val orphan = File(folder, "orphan.avif").apply { writeBytes(ByteArray(10)) }

        trimCache(folder, 10L * 1024 * 1024, emptySet())

        assertTrue(entries.flatten().all { it.isFile })
        assertTrue(orphan.isFile)
    }

    @Test
    fun overTheBudgetTheOldestEntriesGoWithBothFilesAndKeptOnesStay() {
        val folder = temporary.newFolder()
        val entries = (0 until 20).map { cloudEntry(folder, it, 1000, it.toLong()) }
        val newest = entries.first()
        val oldest = entries.last()

        trimCache(folder, 5L * 1100, keep = setOf(oldest[1]))

        val survivors = entries.filter { pair -> pair.all { it.isFile } }
        assertTrue(oldest.all { it.isFile })
        assertTrue(newest.all { it.isFile })
        assertEquals(4, survivors.size)
        assertTrue(entries.none { pair -> pair.count { it.isFile } == 1 })
        assertFalse(entries[10].any { it.isFile })
    }

    @Test
    fun aFullCacheIsTrimmedToNinetyPercentInOnePass() {
        val folder = temporary.newFolder()
        val entries = (0 until 20).map { cloudEntry(folder, it, 1000, it.toLong()) }
        val entryBytes = entries.first().sumOf { it.length() }
        val limit = entryBytes * 18 + 10

        trimCache(folder, limit, emptySet())

        val survivors = entries.filter { pair -> pair.all { it.isFile } }
        val remaining = folder.listFiles().orEmpty().sumOf { it.length() }
        assertTrue(remaining <= limit * 9 / 10)
        assertEquals(16, survivors.size)
        assertEquals(entries.take(16), survivors)
        assertTrue(entries.none { pair -> pair.count { it.isFile } == 1 })
    }

    @Test
    fun theInsertAfterATrimFitsAndTheNextTrimDeletesNothing() {
        val folder = temporary.newFolder()
        val entries = (0 until 20).map { cloudEntry(folder, it, 1000, it.toLong() + 1) }
        val limit = entries.first().sumOf { it.length() } * 18 + 10
        trimCache(folder, limit, emptySet())
        val inserted = cloudEntry(folder, 99, 1000, age = 0)
        val before = folder.listFiles().orEmpty().map { it.name }.toSet()

        trimCache(folder, limit, setOf(inserted[1]))

        assertEquals(before, folder.listFiles().orEmpty().map { it.name }.toSet())
        assertTrue(inserted.all { it.isFile })
    }

    @Test
    fun temporaryAndInFlightFilesAreNeverCountedOrDeleted() {
        val folder = temporary.newFolder()
        val partial = File(folder, "thumb-1.avif").apply { writeBytes(ByteArray(5000)) }
        val staged = File(folder, "cloud-x.tmp").apply { writeBytes(ByteArray(5000)) }
        val entries = (0 until 5).map { cloudEntry(folder, it, 1000, it.toLong()) }

        trimCache(folder, 6_000, emptySet())
        assertTrue(partial.isFile && staged.isFile && entries.flatten().all { it.isFile })

        trimCache(folder, 0, emptySet())
        assertTrue(partial.isFile && staged.isFile)
        assertTrue(entries.flatten().none { it.isFile })
    }
}
