package app.justmaple.aperture

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import app.justmaple.aperture.ui.MapleShell
import app.justmaple.aperture.ui.MapleTheme

class MainActivity : ComponentActivity() {
    private val model: MapleViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContent { MapleTheme { MapleShell(model) } }
        if (savedInstanceState == null) openIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openIntent(intent)
    }

    private fun openIntent(intent: Intent) {
        val uri =
            when (intent.action) {
                Intent.ACTION_VIEW -> intent.data
                Intent.ACTION_SEND ->
                    if (android.os.Build.VERSION.SDK_INT >= 33)
                        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                    else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
                else -> null
            }
        if (uri != null && uri.scheme in setOf("content", "file")) model.openSingle(uri)
    }

    override fun onStop() {
        model.saveOnStop()
        super.onStop()
    }
}
