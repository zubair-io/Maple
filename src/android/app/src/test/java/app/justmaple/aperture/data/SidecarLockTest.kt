package app.justmaple.aperture.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SidecarLockTest {
    @Test
    fun sharedHoldersRunTogether() = runTest {
        val lock = SidecarLock()
        val bothInside = CompletableDeferred<Unit>()
        var inside = 0
        val readers = List(2) {
            launch {
                lock.shared {
                    if (++inside == 2) bothInside.complete(Unit)
                    bothInside.await()
                }
            }
        }
        advanceUntilIdle()

        assertTrue("two shared readers were inside at once", bothInside.isCompleted)
        readers.forEach { assertTrue(it.isCompleted) }
    }

    @Test
    fun anExclusiveHolderKeepsSharedReadersOutAndTheyEnterAfterIt() = runTest {
        val lock = SidecarLock()
        val release = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()
        launch { lock.exclusive { order += "writer in"; release.await(); order += "writer out" } }
        advanceUntilIdle()
        val reader = launch { lock.shared { order += "reader in" } }
        advanceUntilIdle()

        assertFalse("the reader waits for the writer", reader.isCompleted)
        release.complete(Unit)
        advanceUntilIdle()

        assertEquals(listOf("writer in", "writer out", "reader in"), order)
    }

    @Test
    fun aSharedHolderKeepsAnExclusiveHolderOut() = runTest {
        val lock = SidecarLock()
        val release = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()
        launch { lock.shared { order += "reader in"; release.await(); order += "reader out" } }
        advanceUntilIdle()
        val writer = launch { lock.exclusive { order += "writer in" } }
        advanceUntilIdle()

        assertFalse(writer.isCompleted)
        release.complete(Unit)
        advanceUntilIdle()

        assertEquals(listOf("reader in", "reader out", "writer in"), order)
    }

    @Test
    fun aCancelledExclusiveWaiterReleasesWhatItAlreadyTook() = runTest {
        val lock = SidecarLock()
        val release = CompletableDeferred<Unit>()
        launch { lock.shared { release.await() } }
        advanceUntilIdle()
        val writer = launch { lock.exclusive { fail("must not run") } }
        advanceUntilIdle()
        writer.cancel()
        release.complete(Unit)
        advanceUntilIdle()
        var entered = false
        lock.exclusive { entered = true }

        assertTrue(entered)
    }

    @Test
    fun aReadThatMustRepairTakesTheExclusiveLockInstead() = runTest {
        val lock = SidecarLock()
        val release = CompletableDeferred<Unit>()
        val other = launch { lock.shared { release.await() } }
        advanceUntilIdle()
        var repaired = false
        val repair = launch { lock.reading(false, { true }) { repaired = true } }
        advanceUntilIdle()

        assertFalse("a repairing read waits for every shared reader", repaired)
        release.complete(Unit)
        advanceUntilIdle()

        assertTrue(repaired)
        assertTrue(other.isCompleted && repair.isCompleted)
    }

    @Test
    fun aWaitingWriterGoesBeforeReadersThatArriveAfterIt() = runTest {
        val lock = SidecarLock()
        val release = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()
        repeat(2) { launch { lock.shared { release.await() } } }
        advanceUntilIdle()
        launch { lock.exclusive { order += "writer" } }
        advanceUntilIdle()
        repeat(6) { index -> launch { lock.shared { order += "reader $index" } } }
        advanceUntilIdle()

        assertEquals("nothing passes the waiting writer, although two permits are free", emptyList<String>(), order)
        release.complete(Unit)
        advanceUntilIdle()

        assertEquals("writer", order.first())
        assertEquals(7, order.size)
    }

    @Test
    fun atMostFourReadsRunAtOnce() = runTest {
        val lock = SidecarLock()
        val release = CompletableDeferred<Unit>()
        var inside = 0
        var most = 0
        repeat(10) {
            launch {
                lock.shared {
                    most = maxOf(most, ++inside)
                    release.await()
                    inside--
                }
            }
        }
        advanceUntilIdle()
        assertEquals(4, most)
        release.complete(Unit)
        advanceUntilIdle()

        assertEquals(4, most)
        assertEquals(0, inside)
    }

    @Test
    fun networkReadsRunOneAtATimeWhileStorageReadsShare() = runTest {
        val lock = SidecarLock()
        val release = CompletableDeferred<Unit>()
        var network = 0
        var mostNetwork = 0
        var storage = 0
        var mostStorage = 0
        repeat(5) {
            launch {
                lock.reading(true, { false }) {
                    mostNetwork = maxOf(mostNetwork, ++network)
                    release.await()
                    network--
                }
            }
        }
        repeat(3) {
            launch {
                lock.reading(false, { false }) {
                    mostStorage = maxOf(mostStorage, ++storage)
                    release.await()
                    storage--
                }
            }
        }
        advanceUntilIdle()
        release.complete(Unit)
        advanceUntilIdle()

        assertEquals("as on main, one cloud sidecar request at a time", 1, mostNetwork)
        assertEquals(3, mostStorage)
        assertEquals(0, network)
    }
}
