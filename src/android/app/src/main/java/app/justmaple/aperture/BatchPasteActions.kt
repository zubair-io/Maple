package app.justmaple.aperture

import androidx.lifecycle.viewModelScope
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.CopiedSettings
import app.justmaple.aperture.generated.AdjustmentTransferGroup
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

fun MapleViewModel.pasteSelection(photos: List<Photo>, groups: List<AdjustmentTransferGroup>, copied: CopiedSettings) {
    viewModelScope.launch {
        try {
            if (!flush()) return@launch
            batchSettings.prepare(photos, copied, groups)
            batchSettings.run()
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            report(failure)
        }
    }
}

fun MapleViewModel.resumeBatchPaste(retryFailed: Boolean = false) {
    viewModelScope.launch {
        try {
            batchSettings.run(retryFailed)
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            report(failure)
        }
    }
}

fun MapleViewModel.dismissBatchPaste() {
    viewModelScope.launch {
        try {
            batchSettings.discard()
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            report(failure)
        }
    }
}
