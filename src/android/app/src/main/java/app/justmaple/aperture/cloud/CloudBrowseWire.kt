package app.justmaple.aperture.cloud

import android.net.Uri
import app.justmaple.aperture.data.Photo
import java.time.Instant
import org.json.JSONObject

internal object CloudBrowseWire {
    fun query(fold: Boolean, cursor: String?): String =
        "?limit=500" + (if (fold) "&stack=1" else "") +
            (cursor?.let { "&cursor=${Uri.encode(it)}" } ?: "")

    fun assetId(row: JSONObject): String? =
        row.optString("id").takeIf { it.isNotEmpty() && it != "null" }

    fun photo(server: String, row: JSONObject, parent: Uri?, fold: Boolean = false): Photo =
        Photo(
            CloudLibrary.address(server, row.getString("address"), row.getString("path")),
            row.getString("name"),
            row.getLong("size"),
            Instant.parse(row.getString("mtime")).toEpochMilli(),
            parent,
            assetId = assetId(row),
            companion = if (fold) companion(server, row) else null,
        )

    fun companion(server: String, row: JSONObject): Photo? {
        val jpeg = row.optJSONObject("stack")?.optJSONObject("companion") ?: return null
        val address = jpeg.optString("address").takeIf { it.isNotEmpty() && it != "null" && ':' in it }
            ?: return null
        val path = jpeg.optString("path").takeIf { it.isNotEmpty() && it != "null" } ?: return null
        val name = jpeg.optString("name")
        if (!name.endsWith(".jpg", ignoreCase = true) && !name.endsWith(".jpeg", ignoreCase = true)) return null
        val folderAddress = address.substringBeforeLast('/', "").ifEmpty { address.substringBefore(':') + ":" }
        return photo(server, jpeg, CloudLibrary.address(server, folderAddress, path.substringBeforeLast('/')))
    }
}
