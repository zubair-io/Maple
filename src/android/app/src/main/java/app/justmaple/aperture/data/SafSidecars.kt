package app.justmaple.aperture.data

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import org.json.JSONObject

/** Calls are serialized by PhotoLibrary's persistence lock. Only XMP siblings are writable. */
internal class SafSidecars(private val context: Context, private val documents: LocalDocuments) {
    private val resolver = context.contentResolver

    private fun journal(photo: Photo) =
        File(
            File(context.filesDir, "sidecar-transactions").apply { mkdirs() },
            PhotoLibrary.digest(photo.uri.toString()) + ".json",
        )

    fun read(photo: Photo, fresh: Boolean = false): String? {
        recover(photo)
        val folder = photo.parent ?: error("Missing sidecar folder")
        val uri =
            documents.list(folder, fresh).find { it.name == photo.sidecarName }?.uri ?: return null
        return try {
            text(uri)
        } catch (failure: java.io.FileNotFoundException) {
            if (fresh) throw failure
            documents.invalidate(folder)
            read(photo, fresh = true)
        }
    }

    fun save(photo: Photo, xml: String, baseline: String?) {
        val folder = photo.parent ?: error("Missing sidecar folder")
        check(read(photo, fresh = true) == baseline) {
            "The sidecar changed outside Maple. Reopen the photo before saving."
        }
        val previous = documents.list(folder).find { it.name == photo.sidecarName }
        val id = UUID.randomUUID().toString()
        val requestedName = ".maple-$id.xmp"
        val backupName = ".maple-$id.backup.xmp"
        val temp =
            DocumentsContract.createDocument(resolver, folder, "application/rdf+xml", requestedName)
                ?: error("Cannot create sidecar")
        val tempName =
            androidx.documentfile.provider.DocumentFile.fromSingleUri(context, temp)?.name
                ?: error("Cannot read staged sidecar name")
        var recorded = false
        try {
            resolver.openOutputStream(temp, "wt")?.use {
                it.write(xml.toByteArray(Charsets.UTF_8))
                it.flush()
            } ?: error("Cannot write sidecar")
            check(read(photo, fresh = true) == baseline) { "The sidecar changed while saving" }
            val transaction =
                JSONObject()
                    .put("id", id)
                    .put("folder", folder.toString())
                    .put("target", photo.sidecarName)
                    .put("temp", tempName)
                    .put("backup", backupName)
                    .put("previous", previous != null)
                    .put("digest", PhotoLibrary.digest(xml))
                    .put("baseline", baseline?.let(PhotoLibrary::digest))
            val record = journal(photo)
            val pending = File.createTempFile("transaction-", ".tmp", record.parentFile)
            try {
                FileOutputStream(pending).use {
                    it.write(transaction.toString().toByteArray(Charsets.UTF_8))
                    it.fd.sync()
                }
                check(pending.renameTo(record)) { "Could not record sidecar replacement" }
            } finally {
                pending.delete()
            }
            recorded = true
            previous?.let { rename(it.uri, backupName) }
            rename(temp, photo.sidecarName)
            documents.invalidate(folder)
            recover(photo)
        } catch (failure: Exception) {
            if (recorded)
                try {
                    recover(photo)
                } catch (recovery: Exception) {
                    failure.addSuppressed(recovery)
                    throw IOException(
                        "Sidecar replacement was interrupted. Previous edits remain in $backupName; reopen the photo to recover them.",
                        failure,
                    )
                }
            throw failure
        } finally {
            if (!recorded) remove(temp)
            documents.invalidate(folder)
        }
    }

    private fun recover(photo: Photo) {
        val record = journal(photo)
        if (!record.exists()) return
        val transaction = JSONObject(record.readText())
        val folder = photo.parent ?: error("Missing recovery folder")
        val tempName = transaction.getString("temp")
        val backupName = transaction.getString("backup")
        val id = transaction.getString("id")
        require(
            UUID.fromString(id).toString() == id &&
                transaction.getString("folder") == folder.toString() &&
                transaction.getString("target") == photo.sidecarName &&
                tempName.matches(Regex("\\.maple-$id\\.xmp(?:\\.[A-Za-z0-9]+)*")) &&
                backupName == ".maple-$id.backup.xmp"
        ) {
            "Invalid sidecar recovery record"
        }
        val entries = documents.list(folder, fresh = true).associateBy { it.name }
        val canonical = entries[photo.sidecarName]
        val backup = entries[backupName]
        val temp = entries[tempName]
        if (canonical != null && backup != null)
            check(PhotoLibrary.digest(text(canonical.uri)) == transaction.getString("digest")) {
                "The sidecar changed during recovery. Previous edits remain in $backupName."
            }
        if (canonical == null) {
            when {
                backup != null -> {
                    check(
                        PhotoLibrary.digest(text(backup.uri)) == transaction.getString("baseline")
                    ) {
                        "The recovery sidecar changed outside Maple"
                    }
                    rename(backup.uri, photo.sidecarName)
                }
                !transaction.getBoolean("previous") && temp != null -> {
                    val xml = text(temp.uri)
                    check(PhotoLibrary.digest(xml) == transaction.getString("digest")) {
                        "Incomplete sidecar recovery file"
                    }
                    XmpDocument(xml).serialize()
                    rename(temp.uri, photo.sidecarName)
                }
                else ->
                    error(
                        "Interrupted sidecar replacement could not be recovered. The original photo is unchanged."
                    )
            }
        }
        // Re-query because document IDs may change during a provider rename.
        val restored = documents.list(folder, fresh = true).associateBy { it.name }
        check(restored.containsKey(photo.sidecarName)) {
            "Storage provider did not restore the sidecar"
        }
        listOf(tempName, backupName).mapNotNull(restored::get).forEach { remove(it.uri) }
        check(record.delete()) { "Could not finish sidecar recovery" }
        documents.invalidate(folder)
    }

    private fun text(uri: Uri): String =
        resolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
            ?: error("Cannot read sidecar")

    private fun rename(uri: Uri, name: String): Uri =
        DocumentsContract.renameDocument(resolver, uri, name)
            ?: error("Storage provider could not rename sidecar to $name")

    private fun remove(uri: Uri) {
        check(DocumentsContract.deleteDocument(resolver, uri)) {
            "Could not remove a temporary sidecar"
        }
    }
}
