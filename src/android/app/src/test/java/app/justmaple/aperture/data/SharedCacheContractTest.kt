package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import org.junit.Assert.*
import org.junit.Test

class SharedCacheContractTest {
    @Test
    fun portableBasenameHashesMatchAppleAndApi() {
        assertEquals(
            "8fd710b39cdc1a26.v${AdjustmentFields.pipelineOutputVersion}.avif",
            SharedCacheTier.Thumbnail.filename("IMG_0001.ARW"),
        )
        assertEquals(
            "88bab9b0d022c93c.v${AdjustmentFields.pipelineOutputVersion}.avif",
            SharedCacheTier.Thumbnail.filename("panorama-test.png"),
        )
        assertEquals(
            "Photo 📷.DNG.v${AdjustmentFields.pipelineOutputVersion}.avif",
            SharedCacheTier.Preview.filename("Photo 📷.DNG"),
        )
        assertNotEquals(
            SharedCacheTier.Thumbnail.filename("Photo.dng"),
            SharedCacheTier.Thumbnail.filename("photo.dng"),
        )
        assertThrows(IllegalArgumentException::class.java) {
            SharedCacheTier.Preview.filename("../photo.dng")
        }
    }

    @Test
    fun sharedTiersAreIndependentOfRequestedDisplaySizeAndMatchTheApi() {
        val root =
            generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
                .first { File(it, "AGENTS.md").isFile }
        val api = File(root, "src/api/src/thumbs/render.ts").readText()
        val preview = File(root, "src/api/src/indexer/previewer.ts").readText()
        assertTrue(
            api.contains("export const THUMB_LONG_EDGE_PX = ${SharedCacheTier.Thumbnail.edge};")
        )
        assertTrue(
            api.contains("export const THUMB_AVIF_QUALITY = ${SharedCacheTier.Thumbnail.quality};")
        )
        assertTrue(
            preview.contains("export const PREVIEW_LONG_EDGE_PX = ${SharedCacheTier.Preview.edge};")
        )
        assertTrue(
            preview.contains("PREVIEW_LONG_EDGE_PX,\n    ${SharedCacheTier.Preview.quality},")
        )
        assertEquals(SharedCacheTier.Thumbnail, SharedCacheTier.forEdge(128))
        assertEquals(SharedCacheTier.Thumbnail, SharedCacheTier.forEdge(512))
        assertEquals(SharedCacheTier.Preview, SharedCacheTier.forEdge(2048))
    }
}
