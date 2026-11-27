package app.justmaple.aperture

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.PhotoLibrary
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** D01: one evaluation of `PhotoLibrary.sources`, as the view model runs it on the main thread. */
@TimingBenchmark
@RunWith(AndroidJUnit4::class)
class SourcesTimingTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    private data class Configuration(val label: String, val locals: Int, val cloud: Boolean)

    @Test
    fun evaluatingTheLibrarySourcesOnTheMainThread() {
        val folders = TimingFolders()
        TimingSources.backUp(context)
        try {
            for (name in 1..3) folders.populate("source$name", 3)
            val configurations =
                listOf(
                    Configuration("zero-sources", 0, false),
                    Configuration("one-local", 1, false),
                    Configuration("three-local", 3, false),
                    Configuration("one-local-one-cloud", 1, true),
                    Configuration("three-local-one-cloud", 3, true),
                )
            for (configuration in configurations) {
                val trees = (1..configuration.locals).map { folders.subtree("source$it") }
                TimingSources.set(context, trees, configuration.cloud)
                val library = PhotoLibrary(context)
                val first = evaluate(library, configuration)
                val rounds = List(Timing.rounds * 3) { evaluate(library, configuration) }
                Timing.report("sources.${configuration.label}.first", "ms", listOf(first))
                Timing.report("sources.${configuration.label}", "ms", rounds)
            }
        } finally {
            TimingSources.restore(context)
            folders.fixture.close()
        }
    }

    private fun evaluate(library: PhotoLibrary, configuration: Configuration): Double {
        var elapsed = 0.0
        instrumentation.runOnMainSync {
            val (sources, millis) = Timing.millis { library.sources }
            assertEquals(configuration.locals + if (configuration.cloud) 1 else 0, sources.size)
            elapsed = millis
        }
        return elapsed
    }
}

/**
 * Replaces the app's saved sources for a cold-launch or scroll run; the script drives the app and then runs
 * [LaunchSourcesRestore]. The saved sources and cloud sign-ins are backed up first.
 */
@TimingBenchmark
@RunWith(AndroidJUnit4::class)
class LaunchSourcesSetup {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun configureSources() {
        val folders = TimingFolders()
        val photos = Timing.argument("timingPhotos")?.toInt() ?: 200
        when (val mode = Timing.argument("timingSources") ?: "one-local") {
            "zero" -> TimingSources.set(context, emptyList(), false)
            "one-local",
            "one-local-one-cloud" -> {
                folders.populate("", photos)
                TimingSources.set(context, listOf(folders.tree), mode.endsWith("cloud"))
            }
            else -> error("Unknown timingSources $mode")
        }
        Timing.fact("sources.configured", "mode=${Timing.argument("timingSources")} photos=$photos")
    }
}

/** Puts back the sources and cloud sign-ins that [LaunchSourcesSetup] saved. */
@TimingBenchmark
@RunWith(AndroidJUnit4::class)
class LaunchSourcesRestore {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun restoreSources() {
        TimingSources.restore(context)
        Timing.fact("sources.restored", "done")
    }
}
