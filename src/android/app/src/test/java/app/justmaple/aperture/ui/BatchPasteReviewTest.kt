package app.justmaple.aperture.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import app.justmaple.aperture.data.CopiedSettings
import app.justmaple.aperture.data.XmpDocument
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BatchPasteReviewTest {
    @get:Rule val compose = createComposeRule()

    @Test fun selectionReviewReportsMixedCurrentValuesInsteadOfShowingOnlyTheFirstPhoto() {
        val source = XmpDocument().withAttribute("crs:Exposure2012", "2")
        val first = XmpDocument().withAttribute("crs:Exposure2012", "-1")
        val second = XmpDocument().withAttribute("crs:Exposure2012", "2")
        compose.setContent {
            MapleTheme {
                PasteSettingsDialog(first, CopiedSettings("source.dng", source), true,
                    onPaste = {}, onDismiss = {}, targets = listOf(first to true, second to true))
            }
        }
        compose.onNodeWithContentDescription("Exposure: Mixed to 2").performScrollTo().assertExists()
        compose.onNodeWithText("2 selected photos · absolute copy").assertExists()
    }
}
