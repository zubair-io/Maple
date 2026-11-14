package app.justmaple.aperture.data

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/**
 * A session's one background estimate of a name-only imported Auto WB (#4669). It starts after the
 * As Shot first frame, runs on its own thread from the session's RAW and is adopted on the render
 * thread. Navigation and close cancel it, so the estimate unwinds and frees its RAW reference
 * promptly; once the render thread is closed, the estimate thread frees the work itself. Kept free
 * of JNI behind [Native] so this thread interplay is unit-tested.
 */
internal class ImportedAutoWhiteBalanceEstimate(
    private val native: Native,
    private val renderThread: Executor,
) {
    interface Native {
        /** The session's work, or 0 when there is nothing (left) to resolve. */
        fun create(handle: Long): Long

        fun run(work: Long, cancellation: Long): Boolean

        fun close(work: Long)

        fun createCancellation(): Long

        fun cancel(cancellation: Long)

        fun closeCancellation(cancellation: Long)
    }

    private val lock = Any()
    private var cancellation = 0L

    /**
     * Called on the render thread. [adopt] runs there as well, only for a finished estimate that
     * [isCurrent] still accepts, and must not throw.
     */
    fun start(handle: Long, isCurrent: () -> Boolean, adopt: (work: Long) -> Unit) {
        val work = native.create(handle)
        if (work == 0L) return
        val flag = native.createCancellation()
        synchronized(lock) { cancellation = flag }
        Thread(
                {
                    val resolved = native.run(work, flag)
                    val finish = Runnable {
                        try {
                            if (resolved && isCurrent()) adopt(work)
                        } finally {
                            release(work, flag)
                        }
                    }
                    try {
                        renderThread.execute(finish)
                    } catch (closed: RejectedExecutionException) {
                        // The renderer closed mid-estimate: nothing can adopt the pair.
                        release(work, flag)
                    }
                },
                "Maple imported white balance",
            )
            .start()
    }

    /** From any thread: navigation or close stops the estimate in flight. */
    fun cancel() = synchronized(lock) { if (cancellation != 0L) native.cancel(cancellation) }

    private fun release(work: Long, flag: Long) {
        native.close(work)
        synchronized(lock) {
            if (cancellation == flag) cancellation = 0L
            native.closeCancellation(flag)
        }
    }
}

internal object NativeImportedAutoWhiteBalance : ImportedAutoWhiteBalanceEstimate.Native {
    override fun create(handle: Long) = NativeBridge.createImportedAutoWhiteBalance(handle)

    override fun run(work: Long, cancellation: Long) =
        NativeBridge.runImportedAutoWhiteBalance(work, cancellation)

    override fun close(work: Long) = NativeBridge.closeImportedAutoWhiteBalance(work)

    override fun createCancellation() = NativeBridge.createCancellation()

    override fun cancel(cancellation: Long) = NativeBridge.setCancellation(cancellation, true)

    override fun closeCancellation(cancellation: Long) = NativeBridge.closeCancellation(cancellation)
}
