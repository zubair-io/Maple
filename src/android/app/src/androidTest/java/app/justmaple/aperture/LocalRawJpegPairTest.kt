package app.justmaple.aperture

import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.test.*
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.XmpDocument
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real system DocumentsUI and an external-storage tree: one tile per RAW+JPEG pair (#6042). */
class LocalRawJpegPairTest {
    @get:Rule val compose = mainThreadComposeRule<MainActivity>()

    @Test
    fun aLocalFolderShowsOneTilePerPairAndTheSettingShowsBothFiles() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val resolver = context.contentResolver
        val folderName = "MaplePairs-${UUID.randomUUID()}"
        val raw = instrumentation.context.assets.open("portrait.dng").use { it.readBytes() }
        val jpeg =
            ByteArrayOutputStream()
                .also { bytes ->
                    val bitmap = Bitmap.createBitmap(96, 64, Bitmap.Config.ARGB_8888)
                    try {
                        bitmap.eraseColor(Color.rgb(180, 90, 30))
                        check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, bytes))
                    } finally {
                        bitmap.recycle()
                    }
                }
                .toByteArray()
        val originals =
            mapOf(
                "IMG_1.dng" to raw,
                "img_1.jpg" to jpeg,
                "IMG_2.dng" to raw,
                "IMG_2.jpg" to jpeg,
                "IMG_2.jpeg" to jpeg,
            )
        val media =
            originals.map { (name, bytes) ->
                resolver
                    .insert(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        ContentValues().apply {
                            put(MediaStore.Downloads.DISPLAY_NAME, name)
                            put(
                                MediaStore.Downloads.MIME_TYPE,
                                if (name.endsWith(".dng")) "image/x-adobe-dng" else "image/jpeg",
                            )
                            put(MediaStore.Downloads.RELATIVE_PATH, "Download/$folderName")
                        },
                    )!!
                    .also { uri -> resolver.openOutputStream(uri)!!.use { it.write(bytes) } }
            }
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        val preferences = context.getSharedPreferences("maple-library", 0)
        var folder: Folder? = null
        fun names() = model.state.value.photos.map { it.name }
        fun awaitPhotos(expected: List<String>) =
            try {
                compose.waitUntil(30_000) { !model.state.value.loading && names() == expected }
            } catch (failure: Throwable) {
                throw AssertionError("Expected $expected, listed ${names()}", failure)
            }
        fun children(parent: Uri): Map<String, Uri> =
            resolver
                .query(
                    DocumentsContract.buildChildDocumentsUriUsingTree(
                        parent,
                        DocumentsContract.getDocumentId(parent),
                    ),
                    arrayOf(
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    ),
                    null,
                    null,
                    null,
                )!!
                .use { cursor ->
                    buildMap {
                        while (cursor.moveToNext()) put(
                            cursor.getString(1),
                            DocumentsContract.buildDocumentUriUsingTree(parent, cursor.getString(0)),
                        )
                    }
                }
        fun toggleSetting() {
            compose.onNodeWithContentDescription("Settings").performClick()
            compose.onNode(hasText("General") and hasClickAction()).performClick()
            compose.onNodeWithTag("settings-stack-raw-jpeg").performScrollTo().performClick()
            compose.onNodeWithContentDescription("Close Settings").performClick()
            compose.onNodeWithTag("settings-sheet").assertDoesNotExist()
        }
        try {
            val tree =
                DocumentsContract.buildTreeDocumentUri(
                    "com.android.externalstorage.documents",
                    "primary:Download/$folderName",
                )
            compose.runOnIdle {
                compose.activity.activityResultRegistry
                    .register("local-pair-test", ActivityResultContracts.OpenDocumentTree()) { uri
                        ->
                        uri?.let(model::remember)
                    }
                    .launch(
                        DocumentsContract.buildDocumentUriUsingTree(
                            tree,
                            DocumentsContract.getTreeDocumentId(tree),
                        )
                    )
            }
            clickSystem("Use this folder")
            clickSystem("Allow")
            compose.waitUntil(30_000) {
                model.state.value.folder?.name == folderName && !model.state.value.loading
            }
            val opened = model.state.value.folder!!
            folder = opened
            assertTrue(model.library.stackRawJpeg)

            val folded = listOf("IMG_1.dng", "IMG_2.dng", "IMG_2.jpeg", "IMG_2.jpg")
            awaitPhotos(folded)
            assertNull(model.state.value.error)
            val pair = model.state.value.photos.first()
            assertEquals("img_1.jpg", pair.companion?.name)
            assertEquals(opened.uri, pair.companion?.parent)
            assertTrue(model.state.value.photos.drop(1).all { it.companion == null })
            compose.onNodeWithTag("browse-grid").assertIsDisplayed()
            for (name in folded) compose.onNodeWithTag("browse-photo-$name").assertIsDisplayed()
            compose.onNodeWithTag("browse-photo-img_1.jpg").assertDoesNotExist()
            compose
                .onAllNodesWithContentDescription("RAW+JPEG", useUnmergedTree = true)
                .assertCountEquals(1)
            compose.onNodeWithText("4 photos").assertIsDisplayed()

            val saved = runBlocking {
                model.library.save(pair, XmpDocument().withAttribute("xmp:Rating", "3"), null)
            }
            assertEquals(
                listOf("IMG_1.xmp"),
                children(opened.uri).keys.filter { it.endsWith(".xmp", ignoreCase = true) },
            )

            toggleSetting()
            assertFalse(model.library.stackRawJpeg)
            awaitPhotos(listOf("IMG_1.dng", "img_1.jpg", "IMG_2.dng", "IMG_2.jpeg", "IMG_2.jpg"))
            assertTrue(model.state.value.photos.all { it.companion == null })
            compose.onNodeWithTag("browse-photo-img_1.jpg").assertIsDisplayed()
            compose
                .onAllNodesWithContentDescription("RAW+JPEG", useUnmergedTree = true)
                .assertCountEquals(0)
            compose.onNodeWithText("5 photos").assertIsDisplayed()
            val separateJpeg = model.state.value.photos.single { it.name == "img_1.jpg" }
            assertEquals(
                saved.baseline,
                runBlocking { model.library.loadSidecar(separateJpeg) }.baseline,
            )

            toggleSetting()
            assertTrue(model.library.stackRawJpeg)
            awaitPhotos(folded)
            compose.onNodeWithTag("browse-photo-img_1.jpg").assertDoesNotExist()
            compose
                .onAllNodesWithContentDescription("RAW+JPEG", useUnmergedTree = true)
                .assertCountEquals(1)

            val listed = children(opened.uri)
            for ((name, bytes) in originals)
                resolver.openInputStream(listed.getValue(name))!!.use {
                    assertArrayEquals(name, bytes, it.readBytes())
                }
            assertNull(model.state.value.error)
        } finally {
            compose.activityRule.scenario.close()
            preferences.edit().remove("stack-raw-jpeg").commit()
            try {
                folder?.let { listed ->
                    preferences
                        .edit()
                        .putStringSet(
                            "sources",
                            preferences
                                .getStringSet("sources", emptySet())
                                .orEmpty()
                                .filterNot {
                                    DocumentsContract.getTreeDocumentId(Uri.parse(it)) ==
                                        DocumentsContract.getTreeDocumentId(listed.uri)
                                }
                                .toSet(),
                        )
                        .commit()
                    DocumentsContract.deleteDocument(resolver, listed.uri)
                }
            } finally {
                media.forEach { resolver.delete(it, null, null) }
            }
        }
    }

    private fun clickSystem(label: String) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        fun find(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.text?.toString()?.equals(label, ignoreCase = true) == true) return node
            return (0 until node.childCount).firstNotNullOfOrNull { find(node.getChild(it)) }
        }
        fun clickableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo =
            generateSequence(node) { it.parent }.firstOrNull { it.isClickable } ?: node
        try {
            compose.waitUntil(15_000) {
                find(automation.rootInActiveWindow)
                    ?.let(::clickableAncestor)
                    ?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
            }
        } catch (failure: Throwable) {
            capturePickerFailure("local-raw-jpeg-pair")
            throw failure
        }
    }
}
