package app.justmaple.aperture

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Constraints
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ComposeMainThreadTest {
    @get:Rule val compose = mainThreadComposeRule<ComponentActivity>()

    @Test
    fun effectsResumedByWorkersContinueComposeAndMeasureOnTheMainThread() {
        val main = Looper.getMainLooper().thread
        val strays = ConcurrentLinkedQueue<String>()
        fun onMain(phase: String) {
            val thread = Thread.currentThread()
            if (thread != main) strays += "$phase on ${thread.name}"
        }
        val rounds = 40
        compose.setContent {
            var size by remember { mutableIntStateOf(1) }
            LaunchedEffect(Unit) {
                repeat(rounds) {
                    val next = withContext(Dispatchers.Default) { size + 1 }
                    onMain("effect")
                    size = next
                }
            }
            onMain("composition")
            Box(
                Modifier.testTag("probe").layout { measurable, _ ->
                    onMain("measure")
                    val placeable = measurable.measure(Constraints.fixed(size, size))
                    layout(size, size) { placeable.place(0, 0) }
                }
            )
        }
        compose.waitUntil(30_000) {
            compose.onNodeWithTag("probe").fetchSemanticsNode().size.width == rounds + 1
        }
        assertEquals(emptyList<String>(), strays.toList())
    }
}
