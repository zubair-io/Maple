package app.justmaple.aperture.ui

import android.net.Uri
import app.justmaple.aperture.data.Photo
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BrowseSelectionTest {
    private fun photo(name: String) = Photo(Uri.parse("file:///photos/$name"), name, 1, 1, null)

    @Test fun longPressEntersAndToggleCanLeaveAnEmptyActiveSelection() {
        val entered = BrowseSelectionState().toggle("a")
        assertTrue(entered.active)
        assertEquals(setOf("a"), entered.ids)
        val empty = entered.toggle("a")
        assertTrue(empty.active)
        assertTrue(empty.ids.isEmpty())
    }

    @Test fun selectAllReplacesSelectionWithTheFilteredSetAndClearKeepsMode() {
        val a = photo("a.dng")
        val b = photo("b.dng")
        val all = BrowseSelectionState().toggle("hidden").all(listOf(a, b))
        assertEquals(setOf(a.uri.toString(), b.uri.toString()), all.ids)
        assertTrue(all.clear().active)
        assertTrue(all.clear().ids.isEmpty())
        assertEquals(setOf(b.uri.toString()), all.retain(listOf(b)).ids)
    }

    @Test fun folderChangeAndCancelEndModeWhileSameFolderKeepsVisibleSelection() {
        val selection = BrowseSelection()
        val a = photo("a.dng")
        val b = photo("b.dng")
        selection.reconcile("folder", listOf(a, b))
        selection.selectAll(listOf(a, b))
        selection.reconcile("folder", listOf(a))
        assertEquals(setOf(a.uri.toString()), selection.state.value.ids)
        selection.reconcile("other", listOf(a))
        assertFalse(selection.state.value.active)
        selection.toggle(a)
        selection.cancel()
        assertEquals(BrowseSelectionState(), selection.state.value)
    }
}
