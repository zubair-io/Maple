package app.justmaple.aperture.data

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * The renderer's background estimate (#4669) on real threads: the JNI calls are recorded, the
 * render thread is a real single-thread executor shut down exactly as EditorRenderer.close() does.
 */
class ImportedAutoWhiteBalanceEstimateTest {
    private class Recording(private val resolves: Boolean) : ImportedAutoWhiteBalanceEstimate.Native {
        val running = CountDownLatch(1)
        val finish = CountDownLatch(1)
        val freed = CountDownLatch(2)
        val calls: MutableList<String> = Collections.synchronizedList(mutableListOf())
        @Volatile var cancelled = false

        override fun create(handle: Long) = WORK
        override fun createCancellation() = FLAG
        override fun run(work: Long, cancellation: Long): Boolean {
            running.countDown()
            // The core estimate polls its flag; this one waits for the test or a cancellation.
            while (!cancelled && !finish.await(5, TimeUnit.MILLISECONDS)) {}
            return resolves && !cancelled
        }
        override fun cancel(cancellation: Long) {
            calls += "cancel $cancellation"
            cancelled = true
        }
        override fun close(work: Long) {
            calls += "close $work"
            freed.countDown()
        }
        override fun closeCancellation(cancellation: Long) {
            calls += "closeCancellation $cancellation"
            freed.countDown()
        }
    }

    private val renderThread = Executors.newSingleThreadExecutor { Thread(it, "render") }
    private val uncaught: MutableList<Throwable> = Collections.synchronizedList(mutableListOf())
    private var previousHandler: Thread.UncaughtExceptionHandler? = null

    @Before
    fun captureUncaught() {
        previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, failure -> uncaught += failure }
    }

    @After
    fun restore() {
        renderThread.shutdownNow()
        Thread.setDefaultUncaughtExceptionHandler(previousHandler)
    }

    @Test
    fun closingTheRendererMidEstimateFreesTheWorkOnTheEstimateThread() {
        val native = Recording(resolves = true)
        val estimate = ImportedAutoWhiteBalanceEstimate(native, renderThread)
        val adopted = mutableListOf<Long>()
        estimate.start(HANDLE, { true }) { adopted += it }
        assertTrue(native.running.await(5, TimeUnit.SECONDS))
        // EditorRenderer.close(): cancel, then shut the render dispatcher down.
        estimate.cancel()
        renderThread.shutdown()
        assertTrue("the work and its RAW must be freed", native.freed.await(5, TimeUnit.SECONDS))
        assertEquals(emptyList<Throwable>(), uncaught.toList())
        assertEquals(emptyList<Long>(), adopted)
        assertEquals(listOf("cancel $FLAG", "close $WORK", "closeCancellation $FLAG"), native.calls.toList())
    }

    @Test
    fun aRendererClosedWhileAFinishedEstimateWaitsForItNeverLeaksIt() {
        val native = Recording(resolves = true)
        val estimate = ImportedAutoWhiteBalanceEstimate(native, renderThread)
        val adopted = mutableListOf<Long>()
        estimate.start(HANDLE, { true }) { adopted += it }
        assertTrue(native.running.await(5, TimeUnit.SECONDS))
        renderThread.shutdown()
        native.finish.countDown()
        assertTrue(native.freed.await(5, TimeUnit.SECONDS))
        assertEquals(emptyList<Throwable>(), uncaught.toList())
        assertEquals(emptyList<Long>(), adopted)
        assertEquals(listOf("close $WORK", "closeCancellation $FLAG"), native.calls.toList())
    }

    @Test
    fun navigationCancelsTheEstimatePromptlyAndTheRenderThreadFreesIt() {
        val native = Recording(resolves = true)
        val estimate = ImportedAutoWhiteBalanceEstimate(native, renderThread)
        val adopted = mutableListOf<Long>()
        estimate.start(HANDLE, { true }) { adopted += it }
        assertTrue(native.running.await(5, TimeUnit.SECONDS))
        estimate.cancel()
        assertTrue(native.freed.await(5, TimeUnit.SECONDS))
        assertEquals(emptyList<Long>(), adopted)
        assertEquals(emptyList<Throwable>(), uncaught.toList())
        // A finished estimate holds no flag a later cancellation could touch.
        estimate.cancel()
        assertEquals(listOf("cancel $FLAG", "close $WORK", "closeCancellation $FLAG"), native.calls.toList())
    }

    @Test
    fun aFinishedEstimateIsAdoptedOnTheRenderThreadOnlyWhileItsSessionIsCurrent() {
        for (current in listOf(true, false)) {
            val native = Recording(resolves = true)
            val estimate = ImportedAutoWhiteBalanceEstimate(native, renderThread)
            val adoptedOn = Collections.synchronizedList(mutableListOf<String>())
            estimate.start(HANDLE, { current }) { adoptedOn += Thread.currentThread().name }
            native.finish.countDown()
            assertTrue(native.freed.await(5, TimeUnit.SECONDS))
            assertEquals(if (current) listOf("render") else emptyList(), adoptedOn.toList())
            assertEquals(listOf("close $WORK", "closeCancellation $FLAG"), native.calls.toList())
        }
    }

    private companion object {
        const val HANDLE = 3L
        const val WORK = 7L
        const val FLAG = 11L
    }
}
