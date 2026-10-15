package app.justmaple.aperture

import android.content.ContentValues
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.XmpDocument
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real system DocumentsUI, persisted tree grant, and external-storage XMP files. */
class SafSidecarTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun folderEditsCreateAndReplaceAdjacentSidecarsWithoutTouchingTheRaw() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val folderName = "MapleSaf-${UUID.randomUUID()}"
        val values =
            ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, "portrait.dng")
                put(MediaStore.Downloads.MIME_TYPE, "image/x-adobe-dng")
                put(MediaStore.Downloads.RELATIVE_PATH, "Download/$folderName")
            }
        val media =
            context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
        val original = instrumentation.context.assets.open("portrait.dng").use { it.readBytes() }
        context.contentResolver.openOutputStream(media)!!.use { it.write(original) }
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        var folder: app.justmaple.aperture.data.Folder? = null
        try {
            val tree =
                DocumentsContract.buildTreeDocumentUri(
                    "com.android.externalstorage.documents",
                    "primary:Download/$folderName",
                )
            val initial =
                DocumentsContract.buildDocumentUriUsingTree(
                    tree,
                    DocumentsContract.getTreeDocumentId(tree),
                )
            compose.runOnIdle {
                compose.activity.activityResultRegistry
                    .register("saf-test", ActivityResultContracts.OpenDocumentTree()) { uri ->
                        uri?.let(model::remember)
                    }
                    .launch(initial)
            }
            clickSystem {
                it.text?.toString()?.equals("Use this folder", ignoreCase = true) == true
            }
            clickSystem { it.text?.toString()?.equals("Allow", ignoreCase = true) == true }
            compose.waitUntil(30_000) {
                model.state.value.folder?.name == folderName &&
                    model.state.value.photos.size == 1 &&
                    !model.state.value.loading
            }
            assertNull(model.state.value.error)
            folder = model.state.value.folder!!
            val photo = model.state.value.photos.single()
            compose.runOnIdle { model.open(photo) }
            compose.waitUntil(30_000) {
                model.state.value.selected != null && !model.state.value.loading
            }
            compose.onNodeWithText("Edit", useUnmergedTree = true).performClick()
            compose.waitUntil(60_000) {
                model.state.value.values.isNotEmpty() && !model.state.value.rendering
            }
            compose.waitForIdle()
            compose.waitUntil(30_000) { !model.state.value.rendering }
            for (exposure in listOf(.75f, 1.25f)) {
                compose.runOnIdle {
                    model.setField("exposure", exposure)
                    model.commitGesture()
                }
                compose.waitUntil(30_000) {
                    !model.state.value.saving &&
                        (!model.state.value.dirty || model.state.value.error != null)
                }
                assertNull("SAF save must succeed", model.state.value.error)
                assertFalse(model.state.value.dirty)
                val saved = runBlocking { model.library.loadSidecar(photo) }
                assertEquals(
                    XmpDocument.format(exposure),
                    saved.document.attribute("crs:Exposure2012"),
                )
            }
            context.contentResolver.openInputStream(photo.uri)!!.use {
                assertArrayEquals(original, it.readBytes())
            }
            val baseline = runBlocking { model.library.loadSidecar(photo) }
            runBlocking {
                assertTrue(
                    runCatching {
                        model.library.save(
                            photo,
                            baseline.document.withAttribute("xmp:Rating", "5"),
                            null,
                        )
                    }
                        .isFailure
                )
                assertEquals(baseline.baseline, model.library.loadSidecar(photo).baseline)
            }
            val children =
                DocumentsContract.buildChildDocumentsUriUsingTree(
                    folder.uri,
                    DocumentsContract.getDocumentId(folder.uri),
                )
            val names =
                context.contentResolver
                    .query(
                        children,
                        arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                        null,
                        null,
                        null,
                    )!!
                    .use { cursor ->
                        buildList { while (cursor.moveToNext()) add(cursor.getString(0)) }
                    }
            assertEquals(setOf("portrait.dng", "portrait.xmp"), names.toSet())
        } finally {
            folder?.let { selected ->
                val preferences = context.getSharedPreferences("maple-library", 0)
                preferences
                    .edit()
                    .putStringSet(
                        "sources",
                        preferences
                            .getStringSet("sources", emptySet())
                            .orEmpty()
                            .filterNot {
                                DocumentsContract.getTreeDocumentId(android.net.Uri.parse(it)) ==
                                    DocumentsContract.getTreeDocumentId(selected.uri)
                            }
                            .toSet(),
                    )
                    .commit()
                DocumentsContract.deleteDocument(context.contentResolver, selected.uri)
            }
            context.contentResolver.delete(media, null, null)
        }
    }

    private fun clickSystem(matches: (AccessibilityNodeInfo) -> Boolean) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        var target: AccessibilityNodeInfo? = null
        fun find(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
            if (node.isVisibleToUser && matches(node)) return node
            for (index in 0 until node.childCount) node.getChild(index)?.let {
                find(it)?.let { found ->
                    return found
                }
            }
            return null
        }
        try {
            compose.waitUntil(15_000) {
                target = automation.rootInActiveWindow?.let(::find)
                target != null
            }
        } catch (failure: Throwable) {
            fun describe(node: AccessibilityNodeInfo): String =
                "${node.viewIdResourceName} text=${node.text} description=${node.contentDescription}\n" +
                    (0 until node.childCount).mapNotNull(node::getChild).joinToString("") {
                        describe(it)
                    }
            throw AssertionError(
                "File picker accessibility tree:\n" +
                    automation.rootInActiveWindow?.let(::describe),
                failure,
            )
        }
        var clickable = target!!
        while (!clickable.isClickable && clickable.parent != null) clickable = clickable.parent
        assertTrue(
            "System file-picker action must be clickable",
            clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK),
        )
    }
}
