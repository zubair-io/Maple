package app.justmaple.aperture.data

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import org.json.JSONObject

/** Calls share PhotoLibrary's process-wide persistence lock. Only XMP siblings are writable. */
internal class SafSidecars(private val context: Context, private val documents: LocalDocuments) {
    private val resolver = context.contentResolver

    private fun journal(photo: Photo) =
        File(
            File(context.filesDir, "sidecar-transactions").apply { mkdirs() },
            PhotoLibrary.digest(photo.uri.toString()) + ".json",
        )

    fun recoveryPending(photo: Photo): Boolean =
        journal(photo).exists() || photo.companion?.let { journal(it).exists() } == true

    // A missing date, or one within 3 s of now (volumes with 2 s timestamps), could hide a same-length rewrite: never reused.
    fun stamp(photo: Photo, entries: List<LocalDocument>, savedHere: Int, now: Long): SidecarStamp? {
        if (recoveryPending(photo)) return null
        val sidecar = runCatching { find(entries, photo.sidecarName) }.getOrElse { return null }
        if (sidecar != null && (sidecar.modified <= 0 || now - sidecar.modified < COARSE_TIMESTAMP_MILLIS)) return null
        return SidecarStamp(sidecar?.uri, sidecar?.size ?: 0, sidecar?.modified ?: 0, savedHere)
    }

    fun read(photo: Photo, fresh: Boolean = false): String? {
        // A folded RAW shares its sidecar with the hidden JPEG, whose journal is keyed by the JPEG.
        photo.companion?.let(::recover)
        recover(photo)
        val folder = photo.parent ?: error("Missing sidecar folder")
        val uri = find(documents.list(folder, fresh), photo.sidecarName)?.uri ?: return null
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
        val previous = find(documents.list(folder), photo.sidecarName)
        val targetName = previous?.name ?: photo.sidecarName
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
                it.write(XmpEncoding.encode(xml))
                it.flush()
            } ?: error("Cannot write sidecar")
            check(read(photo, fresh = true) == baseline) { "The sidecar changed while saving" }
            val transaction =
                JSONObject()
                    .put("id", id)
                    .put("folder", folder.toString())
                    .put("target", targetName)
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
            rename(temp, targetName)
            documents.invalidate(folder)
            recover(photo)
        } catch (failure: Exception) {
            if (recorded)
                try {
                    recover(photo)
                } catch (recovery: Exception) {
                    failure.addSuppressed(recovery)
                    throw IOException(
                        "Sidecar replacement was interrupted. Recovery files were preserved in this folder; reopen the photo to retry.",
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
        val targetName = transaction.getString("target")
        require(
            UUID.fromString(id).toString() == id &&
                transaction.getString("folder") == folder.toString() &&
                targetName.equals(photo.sidecarName, ignoreCase = true) &&
                tempName.matches(
                    Regex("\\.maple-$id\\.xmp(?:\\.[A-Za-z0-9]+)*", RegexOption.IGNORE_CASE)
                ) &&
                backupName == ".maple-$id.backup.xmp"
        ) {
            "Invalid sidecar recovery record"
        }
        val entries = documents.list(folder, fresh = true)
        val canonical = find(entries, targetName)
        val backup = find(entries, backupName)
        val temp = find(entries, tempName)
        if (canonical != null && (backup != null || !transaction.getBoolean("previous")))
            check(PhotoLibrary.digest(text(canonical.uri)) == transaction.getString("digest")) {
                "The sidecar changed during recovery. Recovery files were preserved in this folder."
            }
        if (canonical == null) {
            when {
                backup != null -> {
                    check(
                        PhotoLibrary.digest(text(backup.uri)) == transaction.getString("baseline")
                    ) {
                        "The recovery sidecar changed outside Maple"
                    }
                    rename(backup.uri, targetName)
                }
                !transaction.getBoolean("previous") && temp != null -> {
                    val xml = text(temp.uri)
                    check(PhotoLibrary.digest(xml) == transaction.getString("digest")) {
                        "Incomplete sidecar recovery file"
                    }
                    XmpDocument(xml).serialize()
                    rename(temp.uri, targetName)
                }
                else ->
                    error(
                        "Interrupted sidecar replacement could not be recovered. The original photo is unchanged."
                    )
            }
        }
        // Re-query because document IDs may change during a provider rename.
        val restored = documents.list(folder, fresh = true)
        check(find(restored, targetName) != null) {
            "Storage provider did not restore the sidecar"
        }
        listOf(tempName, backupName).mapNotNull { find(restored, it) }.forEach { remove(it.uri) }
        check(record.delete()) { "Could not finish sidecar recovery" }
        documents.invalidate(folder)
    }

    private fun text(uri: Uri): String =
        resolver.openInputStream(uri)?.use { XmpEncoding.decode(it.readBytes()) }
            ?: error("Cannot read sidecar")

    private fun find(entries: List<LocalDocument>, name: String): LocalDocument? {
        val key = RawJpegPairing.sidecarKey(name)
        val matches =
            entries.filter { !it.directory && RawJpegPairing.sidecarKey(it.name) == key }
        check(matches.size <= 1) {
            "Multiple sidecars match $name; resolve the duplicate files before editing"
        }
        return matches.singleOrNull()
    }

    private fun rename(uri: Uri, name: String): Uri =
        DocumentsContract.renameDocument(resolver, uri, name)
            ?: error("Storage provider could not rename sidecar to $name")

    private fun remove(uri: Uri) {
        check(DocumentsContract.deleteDocument(resolver, uri)) {
            "Could not remove a temporary sidecar"
        }
    }

    private companion object {
        const val COARSE_TIMESTAMP_MILLIS = 3_000L
    }
}
