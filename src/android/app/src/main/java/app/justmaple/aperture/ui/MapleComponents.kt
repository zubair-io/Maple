package app.justmaple.aperture.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.cloud.CloudDerivativePending
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.generated.UiTokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

@Composable
fun MuiIconButton(
    label: String,
    icon: ImageVector,
    enabled: Boolean = true,
    selected: Boolean? = null,
    onClick: () -> Unit,
) {
    val chosen = selected
    IconButton(
        onClick,
        enabled = enabled,
        modifier = Modifier.size(44.dp).semantics { if (chosen != null) this.selected = chosen },
    ) {
        Icon(
            icon,
            label,
            tint =
                if (selected == true) MapleColors.primary
                else if (enabled) MapleColors.text else MapleColors.muted.copy(alpha = .35f),
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
fun MuiHeader(
    title: String,
    leading: @Composable () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Text(
            title,
            Modifier.weight(1f).padding(horizontal = 8.dp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
        )
        actions()
    }
}

@Composable
fun PhotoThumbnail(
    photo: Photo,
    library: PhotoLibrary,
    modifier: Modifier = Modifier,
    fit: Boolean = false,
    revision: String? = null,
) {
    var image by
        remember(photo.key) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    var failed by remember(photo.key) { mutableStateOf(false) }
    LaunchedEffect(photo.key, revision, fit) {
        suspend fun load(edge: Int): androidx.compose.ui.graphics.ImageBitmap? {
            return library.withThumbnail(photo, edge) { _, input ->
                BitmapFactory.decodeFileDescriptor(input.fd)?.asImageBitmap()
            }
        }
        while (currentCoroutineContext().isActive) {
            try {
                image = load(if (fit) 2048 else 512)
                failed = image == null
                break
            } catch (pending: CloudDerivativePending) {
                if (image == null && fit) {
                    try {
                        image = load(512)
                        failed = image == null
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        failed = true
                    }
                }
                delay(pending.retryMillis)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                failed = true
                break
            }
        }
    }
    Box(modifier.background(MapleColors.raised), contentAlignment = Alignment.Center) {
        val loaded = image
        if (loaded != null)
            Image(
                loaded,
                photo.name,
                Modifier.fillMaxSize(),
                contentScale = if (fit) ContentScale.Fit else ContentScale.Crop,
            )
        else if (failed)
            Text(photo.extension.uppercase(), color = MapleColors.muted, fontSize = 10.sp)
        else
            CircularProgressIndicator(
                Modifier.size(16.dp),
                strokeWidth = 1.dp,
                color = MapleColors.muted,
            )
    }
}

@Composable
fun MuiEmptyState(
    title: String,
    description: String,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(description, color = MapleColors.muted)
        if (action != null && onAction != null) {
            Spacer(Modifier.height(24.dp))
            Button(onAction, shape = RoundedCornerShape(UiTokens.radius_md.dp)) { Text(action) }
        }
    }
}

@Composable
fun MuiSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(
            title.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MapleColors.muted,
        )
        Spacer(Modifier.height(12.dp))
        content()
    }
    HorizontalDivider(color = MapleColors.border, thickness = .5.dp)
}
