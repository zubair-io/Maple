package app.justmaple.aperture

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher

/**
 * The app composes on the main thread. The rule's default unconfined dispatcher instead resumes an
 * effect on the worker that finished its withContext, which then recomposes and lays out on that
 * worker while the UI thread draws (#4975, #5203). Queue those resumptions on the test clock.
 */
@OptIn(ExperimentalCoroutinesApi::class)
inline fun <reified A : ComponentActivity> mainThreadComposeRule() =
    createAndroidComposeRule<A>(effectContext = StandardTestDispatcher())
