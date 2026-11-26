package app.justmaple.aperture.data

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock

/**
 * Sidecar journals and files are shared by every library instance. A save, or a read that first repairs
 * an interrupted save, excludes everything and goes first; reads that find nothing to repair share, a few at a time.
 */
internal class SidecarLock {
    private val readers = Semaphore(MAX_READERS)
    private val entry = Mutex()
    private val networkReads = Mutex()

    // Readers pass through [entry] before taking a permit, so a waiting writer holds back every later reader.
    suspend fun <T> shared(block: suspend () -> T): T {
        entry.withLock { readers.acquire() }
        try {
            return block()
        } finally {
            readers.release()
        }
    }

    suspend fun <T> exclusive(block: suspend () -> T): T =
        entry.withLock {
            var held = 0
            try {
                repeat(MAX_READERS) {
                    readers.acquire()
                    held++
                }
                block()
            } finally {
                repeat(held) { readers.release() }
            }
        }

    /** A journal can only appear or vanish under the exclusive lock, so the check holds for the whole shared read. */
    suspend fun <T> reading(network: Boolean, recoveryPending: () -> Boolean, block: suspend () -> T): T {
        if (network) return networkReads.withLock { reading(false, recoveryPending, block) }
        val shared = shared { if (recoveryPending()) null else Completed(block()) }
        return if (shared != null) shared.value else exclusive(block)
    }

    private class Completed<T>(val value: T)

    private companion object {
        const val MAX_READERS = 4
    }
}
