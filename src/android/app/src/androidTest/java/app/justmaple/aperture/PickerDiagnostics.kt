package app.justmaple.aperture

import android.accessibilityservice.AccessibilityServiceInfo
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File

internal fun capturePickerFailure(label: String) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val automation = instrumentation.uiAutomation
    val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "picker-diagnostics")
    directory.mkdirs()
    val prefix = "${label}-${System.nanoTime()}"
    fun describe(node: AccessibilityNodeInfo?): String =
        if (node == null) "null\n"
        else
            "${node.packageName} ${node.viewIdResourceName} text=${node.text} " +
                "visible=${node.isVisibleToUser} clickable=${node.isClickable}\n" +
                (0 until node.childCount).joinToString("") { describe(node.getChild(it)) }
    val info = automation.serviceInfo
    val flags = info.flags
    val before = "service=$info\nactive root before retrieval flag:\n${describe(automation.rootInActiveWindow)}"
    try {
        info.flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        automation.serviceInfo = info
        val windows = automation.windows.joinToString("\n") {
            "$it\n${describe(it.root)}"
        }
        val report = "$before\ninteractive windows:\n$windows"
        File(directory, "$prefix-windows.txt").writeText(report)
        Log.e("MaplePickerDiagnostics", report)
        automation.takeScreenshot()?.let { frame ->
            try {
                File(directory, "$prefix.png").outputStream().use {
                    frame.compress(Bitmap.CompressFormat.PNG, 100, it)
                }
            } finally {
                frame.recycle()
            }
        }
        for (service in listOf("accessibility", "window", "activity activities")) {
            automation.executeShellCommand("dumpsys $service").use { descriptor ->
                ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { stream ->
                    File(directory, "$prefix-${service.replace(' ', '-')}.txt").outputStream().use {
                        stream.copyTo(it)
                    }
                }
            }
        }
    } catch (failure: Throwable) {
        Log.e("MaplePickerDiagnostics", "Could not capture picker evidence", failure)
    } finally {
        info.flags = flags
        automation.serviceInfo = info
    }
}
