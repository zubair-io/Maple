package app.justmaple.aperture.ui

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.MapleViewModel

@Composable
internal fun CloudConnectionDialog(
    model: MapleViewModel,
    signingIn: Boolean,
    onDismiss: () -> Unit,
) {
    var domain by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = {
            model.cancelCloudLogin()
            onDismiss()
        },
        title = { Text("Add a Maple Cloud server") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (signingIn) {
                    CircularProgressIndicator(color = MapleColors.primary)
                    Text("Complete sign-in in your browser, then return to Maple.")
                } else {
                    Text(
                        "Enter your Maple Cloud or self-hosted server domain. Sign-in opens in your browser."
                    )
                    OutlinedTextField(
                        domain,
                        { domain = it },
                        Modifier.fillMaxWidth(),
                        label = { Text("myserver.com") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    )
                }
            }
        },
        confirmButton = {
            if (!signingIn)
                TextButton(
                    onClick = {
                        model.beginCloud(domain)?.let { uri ->
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                                .onFailure {
                                    model.cancelCloudLogin()
                                    model.report(it)
                                }
                        }
                    },
                    enabled = domain.isNotBlank(),
                ) {
                    Text("Continue")
                }
        },
        dismissButton = {
            TextButton({
                model.cancelCloudLogin()
                onDismiss()
            }) {
                Text("Cancel")
            }
        },
        containerColor = MapleColors.surface,
    )
}
