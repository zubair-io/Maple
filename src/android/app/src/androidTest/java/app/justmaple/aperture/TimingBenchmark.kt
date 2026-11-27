package app.justmaple.aperture

import android.os.Bundle
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File

/**
 * Device timing runs. The default device-test invocation excludes this annotation
 * (`notAnnotation` in build.gradle.kts); `scripts/timing-device.sh` selects it.
 */
@Retention(AnnotationRetention.RUNTIME)
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION)
annotation class TimingBenchmark

internal object Timing {
    private val arguments = InstrumentationRegistry.getArguments()

    val rounds: Int = arguments.getString("timingRounds")?.toInt() ?: 7

    fun argument(name: String): String? = arguments.getString(name)

    fun report(name: String, unit: String, values: List<Double>, note: String = "") {
        require(values.isNotEmpty()) { "$name has no values to report" }
        val sorted = values.sorted()
        val median =
            if (sorted.size % 2 == 1) sorted[sorted.size / 2]
            else (sorted[sorted.size / 2 - 1] + sorted[sorted.size / 2]) / 2
        val line =
            "$name unit=$unit n=${values.size} min=${format(sorted.first())} median=${format(median)} " +
                "max=${format(sorted.last())} rounds=${values.joinToString(",") { format(it) }}" +
                if (note.isEmpty()) "" else " note=\"$note\""
        emit(line)
    }

    fun reportFirstAndLater(name: String, unit: String, rounds: List<Double>, note: String = "") {
        report("$name.first-round", unit, rounds.take(1), note)
        if (rounds.size > 1) report("$name.later-rounds", unit, rounds.drop(1), note)
    }

    fun fact(name: String, value: String) = emit("$name $value")

    private fun emit(line: String) {
        Log.i("MapleTiming", line)
        InstrumentationRegistry.getInstrumentation()
            .sendStatus(0, Bundle().apply { putString("maple_timing", line) })
    }

    private fun format(value: Double) = "%.3f".format(value)

    inline fun <T> millis(block: () -> T): Pair<T, Double> {
        val start = System.nanoTime()
        val result = block()
        return result to (System.nanoTime() - start) / 1e6
    }
}

/** The RAW a script staged with `timing-device.sh`, else the committed 96 x 64 fixture. */
internal object TimingRaw {
    fun file(): File {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val staged = File(context.filesDir, "maple-timing/raw").listFiles()?.singleOrNull()
        if (staged != null) return staged
        val fallback = File(context.filesDir, "maple-timing/raw-fallback/source.dng")
        if (!fallback.isFile) {
            fallback.parentFile!!.mkdirs()
            InstrumentationRegistry.getInstrumentation().context.assets.open("source.dng").use { input ->
                fallback.outputStream().use(input::copyTo)
            }
        }
        return fallback
    }
}
