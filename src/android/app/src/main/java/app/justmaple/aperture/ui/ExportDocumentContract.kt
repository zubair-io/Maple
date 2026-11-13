package app.justmaple.aperture.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.saveable.listSaver

internal val ExportOptionsSaver = listSaver<ExportOptions, Any>(
    save = { listOf(it.format.name, it.quality, it.maxEdge, it.colorSpace.name) },
    restore = { ExportOptions(ExportFormat.valueOf(it[0] as String), it[1] as Int, it[2] as Int, ExportColorSpace.valueOf(it[3] as String)) },
)

internal class ExportDocumentContract(private val sourceName: String?) : ActivityResultContract<ExportOptions, Uri?>() {
    override fun createIntent(context: Context, input: ExportOptions): Intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(input.format.mimeType).putExtra(Intent.EXTRA_TITLE, input.suggestedFileName(sourceName))

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        intent?.data?.takeIf { resultCode == Activity.RESULT_OK }
}
