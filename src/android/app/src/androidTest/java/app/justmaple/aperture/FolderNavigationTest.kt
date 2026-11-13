package app.justmaple.aperture

import android.content.ContentValues
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real SAF folders exercise both the Browse tiles and the independent navigation tree. */
class FolderNavigationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun folderTilesAndNavigationShareTheSelectedHierarchy() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val resolver = context.contentResolver
        val fixturePath = "Download/MapleFolders-${UUID.randomUUID()}/Portfolio"
        val media =
            resolver.insert(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, "rgb-gradient.png")
                    put(MediaStore.Downloads.MIME_TYPE, "image/png")
                    put(MediaStore.Downloads.RELATIVE_PATH, fixturePath)
                },
            )!!
        val original =
            instrumentation.context.assets.open("rgb-gradient.png").use { it.readBytes() }
        resolver.openOutputStream(media)!!.use { it.write(original) }
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        var root: app.justmaple.aperture.data.Folder? = null
        try {
            val tree =
                DocumentsContract.buildTreeDocumentUri(
                    "com.android.externalstorage.documents",
                    "primary:$fixturePath",
                )
            val initial =
                DocumentsContract.buildDocumentUriUsingTree(
                    tree,
                    DocumentsContract.getTreeDocumentId(tree),
                )
            compose.runOnIdle {
                compose.activity.activityResultRegistry
                    .register("folder-parity", ActivityResultContracts.OpenDocumentTree()) { uri ->
                        uri?.let(model::remember)
                    }
                    .launch(initial)
            }
            clickSystem {
                it.text?.toString()?.equals("Use this folder", ignoreCase = true) == true
            }
            clickSystem { it.text?.toString()?.equals("Allow", ignoreCase = true) == true }
            compose.waitUntil(30_000) {
                model.state.value.folder?.name == "Portfolio" && !model.state.value.loading
            }
            root = model.state.value.folder!!
            fun directory(parent: Uri, name: String) =
                DocumentsContract.createDocument(
                    resolver,
                    parent,
                    DocumentsContract.Document.MIME_TYPE_DIR,
                    name,
                )!!
            val iceland = directory(root.uri, "Iceland")
            directory(iceland, "Day 1")
            directory(root.uri, "Faroe Islands")
            directory(root.uri, ".maple")
            directory(root.uri, "A much longer folder name that truncates")
            compose.runOnIdle { model.browse(root) }
            compose.waitUntil(30_000) {
                !model.state.value.loading && model.state.value.folders.size == 3
            }
            val tile = compose.onNodeWithContentDescription("Folder Iceland")
            val bounds = tile.getUnclippedBoundsInRoot()
            assertEquals(180f, (bounds.right - bounds.left).value, .5f)
            assertEquals(64f, (bounds.bottom - bounds.top).value, .5f)
            compose.waitUntil(30_000) {
                compose
                    .onAllNodesWithContentDescription("rgb-gradient.png")
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            val photo =
                compose.onNodeWithContentDescription("rgb-gradient.png").getUnclippedBoundsInRoot()
            assertTrue("Folder block must be above the photo grid", bounds.bottom < photo.top)
            compose.onNodeWithContentDescription("Smaller thumbnails").performClick()
            assertEquals(
                bounds.right - bounds.left,
                tile.getUnclippedBoundsInRoot().let { it.right - it.left },
            )
            assertEquals(
                bounds.bottom - bounds.top,
                tile.getUnclippedBoundsInRoot().let { it.bottom - it.top },
            )
            openNavigation()
            compose.onNodeWithContentDescription("Expand folder Portfolio").performClick()
            compose
                .onNode(
                    hasText("Iceland") and
                        hasClickAction() and
                        hasAnyAncestor(hasTestTag("folder-navigation"))
                )
                .assertIsDisplayed()
            compose.captureWalkthrough("06-folders-navigation")
            closeDrawer()
            compose.captureWalkthrough("07-folders-browse")
            tile.performClick()
            compose.waitUntil(30_000) {
                !model.state.value.loading && model.state.value.folder?.name == "Iceland"
            }
            assertEquals(
                listOf("Portfolio", "Iceland"),
                model.state.value.folderTrail.map { it.name },
            )
            openNavigation()
            compose.onNode(hasText("Iceland") and isSelected()).assertIsDisplayed()
            compose.onNodeWithContentDescription("Collapse folder Portfolio").performClick()
            assertEquals("Iceland", model.state.value.folder?.name)
            compose.onNodeWithContentDescription("Expand folder Portfolio").performClick()
            compose.onNode(hasText("Iceland") and isSelected()).assertIsDisplayed()
            compose.captureWalkthrough("08-folders-selected")
            closeDrawer()
            compose.onNodeWithContentDescription("Parent folder").performClick()
            compose.waitUntil(30_000) {
                !model.state.value.loading && model.state.value.folder?.uri == root.uri
            }
            openNavigation()
            compose
                .onNode(
                    hasText("Iceland") and
                        hasClickAction() and
                        hasAnyAncestor(hasTestTag("folder-navigation"))
                )
                .performClick()
            compose.waitUntil(30_000) {
                !model.state.value.loading && model.state.value.folder?.name == "Iceland"
            }
            compose.onNodeWithContentDescription("Folder Day 1").performClick()
            compose.waitUntil(30_000) {
                !model.state.value.loading && model.state.value.folder?.name == "Day 1"
            }
            assertEquals(3, model.state.value.folderTrail.size)
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            compose.waitUntil(30_000) {
                !model.state.value.loading && model.state.value.folder?.name == "Iceland"
            }
            resolver.openInputStream(media)!!.use { assertArrayEquals(original, it.readBytes()) }
            assertNull(model.state.value.error)
        } finally {
            try {
                root?.let { folder ->
                    val preferences = context.getSharedPreferences("maple-library", 0)
                    preferences
                        .edit()
                        .putStringSet(
                            "sources",
                            preferences
                                .getStringSet("sources", emptySet())
                                .orEmpty()
                                .filterNot {
                                    DocumentsContract.getTreeDocumentId(Uri.parse(it)) ==
                                        DocumentsContract.getTreeDocumentId(folder.uri)
                                }
                                .toSet(),
                        )
                        .commit()
                    DocumentsContract.deleteDocument(resolver, folder.uri)
                }
            } finally {
                resolver.delete(media, null, null)
            }
        }
    }

    private fun openNavigation() {
        if (compose.activity.resources.configuration.screenWidthDp < 1000)
            compose.onNodeWithContentDescription("Sources").performClick()
        compose.onNodeWithTag("folder-navigation").assertIsDisplayed()
    }

    private fun closeDrawer() {
        if (compose.activity.resources.configuration.screenWidthDp < 1000)
            compose.onNodeWithContentDescription("Collapse sources").performClick()
    }

    private fun clickSystem(matches: (AccessibilityNodeInfo) -> Boolean) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        fun find(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.isClickable && matches(node)) return node
            return (0 until node.childCount).firstNotNullOfOrNull { find(node.getChild(it)) }
        }
        try {
            compose.waitUntil(15_000) {
                find(automation.rootInActiveWindow)
                    ?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
            }
        } catch (failure: Throwable) {
            capturePickerFailure("folder-navigation")
            throw failure
        }
    }
}
