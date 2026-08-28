using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels
{
    /// <summary>Maple Cloud (#2588): browsing, previewing and culling a
    /// Self-Hosted server's library. Sign-in is the web passkey ceremony via
    /// the PKCE native-code exchange (#856): the browser handles credentials,
    /// the app only ever holds the one-time code + device-scoped tokens.</summary>
    public partial class EditSessionViewModel
    {
        public ObservableCollection<CloudFolder> CloudFolders { get; } = new();

        [ObservableProperty] private string _cloudStatus = "Not connected";
        [ObservableProperty] private bool _cloudConnected;

        private CloudClient? _cloud;
        private CloudPkcePending? _pendingSignIn;
        private CancellationTokenSource? _signInPollCts;
        private const int CloudPageLimit = 200;
        private const int CloudMaxAssets = 2000;

        /// <summary>Step 1: probe the server, then hand the passkey ceremony to
        /// the default browser. The signed-in web app redirects the one-time
        /// code to maple-app://auth-success, which lands in
        /// CompleteAuthCallbackAsync. Returns (ok, message, devLoginEnabled).</summary>
        public async Task<(bool Ok, string Message, bool DevLoginEnabled)> StartBrowserSignInAsync(string serverUrl)
        {
            _signInPollCts?.Cancel();
            _cloud?.Dispose();
            _cloud = new CloudClient(serverUrl);
            HookTokenRotation(_cloud);
            var (ok, message, devLogin) = await _cloud.ProbeAsync(CancellationToken.None);
            if (!ok)
            {
                CloudStatus = $"Connection failed: {message}";
                return (false, message, false);
            }

            _pendingSignIn = CloudPkce.Begin(serverUrl);
            var url = _cloud.BuildBrowserSignInUrl(
                CloudPkce.ChallengeFor(_pendingSignIn.Verifier), _pendingSignIn.State);
            System.Diagnostics.Process.Start(
                new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });
            CloudStatus = "Waiting for browser sign-in…";
            StartSignInPolling(_pendingSignIn, _cloud);
            return (true, message, devLogin);
        }

        /// <summary>Poll the server for the pending ceremony's code (#3063).
        /// The maple-app:// redirect is the fast path, but Chromium refuses to
        /// launch an external scheme from a script navigation with no user
        /// gesture — which is exactly what an already-signed-in browser does
        /// (the #2964 bootstrap redirect). The signed-in web app still MINTS
        /// the code server-side, so polling with the private verifier
        /// completes the sign-in without any browser cooperation. First of
        /// the redirect/poll paths to complete wins; the other no-ops.</summary>
        private void StartSignInPolling(CloudPkcePending pending, CloudClient client)
        {
            _signInPollCts?.Cancel();
            var cts = new CancellationTokenSource(TimeSpan.FromMinutes(3));
            _signInPollCts = cts;
            _ = Task.Run(async () =>
            {
                try
                {
                    while (true)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(2), cts.Token);
                        var (ok, fatal, message) = await client.ClaimNativeCodeAsync(
                            pending.State, pending.Verifier, cts.Token);
                        if (fatal)
                        {
                            // Permanent (bad request / user gone) — the ceremony
                            // can never complete; stop polling and surface it.
                            OnUi(() =>
                            {
                                if (_pendingSignIn == pending && _signInPollCts == cts)
                                    CloudStatus = $"Sign-in failed: {message}";
                            });
                            return;
                        }
                        if (!ok)
                            continue; // nothing pending yet (or transient) — keep polling
                        OnUi(() => _ = CompleteClaimedSignInAsync(pending, client, message));
                        return;
                    }
                }
                catch (OperationCanceledException)
                {
                    // Superseded by another ceremony/callback, or the 3-minute
                    // window elapsed. Only the timeout of a STILL-pending
                    // ceremony deserves a status update.
                    OnUi(() =>
                    {
                        if (_pendingSignIn == pending && _signInPollCts == cts)
                            CloudStatus = "Browser sign-in timed out — try again.";
                    });
                }
                catch (ObjectDisposedException)
                {
                    // The client was superseded (disposed) between our cancel
                    // check and the request — this ceremony is over.
                }
                finally
                {
                    // Free the CTS timer promptly. On the UI thread, and only
                    // after un-publishing the field, so the Cancel() call sites
                    // (all UI-thread) can never touch a disposed CTS.
                    OnUi(() =>
                    {
                        if (_signInPollCts == cts)
                            _signInPollCts = null;
                        cts.Dispose();
                    });
                }
            });
            // (No cts.Token on Task.Run: a pre-canceled token would skip the
            // body entirely and leak the CTS past its finally.)
        }

        /// <summary>UI-thread tail of a successful poll claim: mirror of
        /// CompleteAuthCallbackAsync's post-redeem steps, guarded so a redirect
        /// callback that already completed this ceremony makes this a no-op.</summary>
        private async Task CompleteClaimedSignInAsync(
            CloudPkcePending pending, CloudClient client, string message)
        {
            if (_pendingSignIn != pending || _cloud != client)
                return;
            _pendingSignIn = null;
            CloudStatus = message;
            PersistCloudSession(pending.ServerUrl, client.RefreshToken);
            await FinishConnectAsync();
        }

        /// <summary>Step 2: the maple-app://auth-success?code=…&state=… callback.
        /// State must match the pending ceremony; the code is redeemed with the
        /// private verifier for device-scoped tokens.</summary>
        public async Task CompleteAuthCallbackAsync(Uri uri)
        {
            var pending = _pendingSignIn;
            if (pending == null || _cloud == null)
            {
                CloudStatus = "Unexpected sign-in callback (no sign-in in progress).";
                return;
            }
            var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
            var code = query["code"];
            var state = query["state"];
            if (string.IsNullOrEmpty(code) || state != pending.State)
            {
                CloudStatus = "Sign-in callback rejected (state mismatch).";
                return;
            }
            _pendingSignIn = null;
            _signInPollCts?.Cancel();

            var (ok, message) = await _cloud.RedeemNativeCodeAsync(
                code!, pending.Verifier, CancellationToken.None);
            CloudStatus = ok ? message : $"Sign-in failed: {message}";
            if (!ok)
                return;
            PersistCloudSession(pending.ServerUrl, _cloud.RefreshToken);
            await FinishConnectAsync();
        }

        /// <summary>Dev-only fallback (server started with MAPLE_DEV_AUTH=1) —
        /// no email, no browser. Probes first when needed.</summary>
        public async Task<(bool Ok, string Message)> DevSignInAsync(string serverUrl)
        {
            _signInPollCts?.Cancel();
            _cloud?.Dispose();
            _cloud = new CloudClient(serverUrl);
            HookTokenRotation(_cloud);
            var (probeOk, probeMessage, devLogin) = await _cloud.ProbeAsync(CancellationToken.None);
            if (!probeOk)
            {
                CloudStatus = $"Connection failed: {probeMessage}";
                return (false, probeMessage);
            }
            if (!devLogin)
            {
                const string message =
                    "This server has dev sign-in disabled — use “Sign in with browser”.";
                CloudStatus = message;
                return (false, message);
            }
            var (ok, message2) = await _cloud.DevLoginAsync(CancellationToken.None);
            CloudStatus = ok ? message2 : $"Sign-in failed: {message2}";
            if (!ok)
                return (false, message2);
            PersistCloudSession(serverUrl, null);
            await FinishConnectAsync();
            return (true, message2);
        }

        /// <summary>Silent reconnect at launch from the DPAPI-protected refresh
        /// token persisted after a successful browser sign-in.</summary>
        public async Task RestoreCloudSessionAsync()
        {
            var settings = AppSettings.Load();
            if (string.IsNullOrEmpty(settings.CloudServerUrl))
                return;
            var refreshToken = settings.UnprotectCloudRefreshToken();
            if (refreshToken == null)
            {
                CloudStatus = "Signed out — connect to reconnect.";
                return;
            }
            CloudStatus = $"Reconnecting to {settings.CloudServerUrl}…";
            _cloud?.Dispose();
            _cloud = new CloudClient(settings.CloudServerUrl!);
            HookTokenRotation(_cloud);
            if (await _cloud.RestoreSessionAsync(refreshToken, CancellationToken.None))
            {
                CloudStatus = $"Connected to {settings.CloudServerUrl}.";
                await FinishConnectAsync();
            }
            else
            {
                CloudStatus = "Session expired — sign in again.";
            }
        }

        private void HookTokenRotation(CloudClient client)
        {
            client.RefreshTokenRotated += rotated =>
                OnUi(() => PersistCloudSession(client.ServerUrl, rotated));
        }

        private static void PersistCloudSession(string serverUrl, string? refreshToken)
        {
            var settings = AppSettings.Load();
            settings.CloudServerUrl = serverUrl;
            if (refreshToken != null)
                settings.ProtectCloudRefreshToken(refreshToken);
            settings.Save();
        }

        private async Task FinishConnectAsync()
        {
            CloudConnected = true;
            var folders = await _cloud!.GetFoldersAsync(CancellationToken.None);
            CloudFolders.Clear();
            foreach (var folder in folders ?? Array.Empty<CloudFolder>())
                CloudFolders.Add(folder);
        }

        /// <summary>Load a server library into the browse grid via the search
        /// feed (culling state, capture dates and camera come straight from the
        /// server), then hydrate AVIF thumbnails into the local cache.</summary>
        public async Task LoadCloudFolderAsync(CloudFolder folder)
        {
            if (_cloud == null)
                return;

            _libraryCts?.Cancel();
            var cts = new CancellationTokenSource();
            _libraryCts = cts;

            CurrentFolderPath = $"{_cloud.ServerUrl} · {folder.DisplayName}";
            ActiveSectionName = folder.DisplayName;
            _libraryWatcher?.Stop();    // no local directory to watch
            AllPhotos.Clear();

            string? cursor = null;
            while (AllPhotos.Count < CloudMaxAssets && !cts.Token.IsCancellationRequested)
            {
                var page = await _cloud.SearchAsync(folder.Id, cursor, CloudPageLimit, cts.Token);
                if (page == null)
                {
                    CloudStatus = "Listing failed — see maple.log";
                    break;
                }
                foreach (var result in page.Results)
                {
                    if (result.Address == null)
                        continue;
                    AllPhotos.Add(CloudPhotoItem(result));
                }
                cursor = page.NextCursor;
                if (string.IsNullOrEmpty(cursor) || page.Results.Length == 0)
                    break;
            }
            if (AllPhotos.Count >= CloudMaxAssets)
                CloudStatus = $"Showing the newest {CloudMaxAssets} photos of {folder.FileCount}.";

            ApplyFilters();
            Timeline.GroupPhotosByDate(AllPhotos);
            _ = Task.Run(() => HydrateCloudThumbnailsAsync(AllPhotos.ToList(), cts.Token), cts.Token);
        }

        private static PhotoItem CloudPhotoItem(CloudSearchResult result)
        {
            var ext = System.IO.Path.GetExtension(result.Filename).TrimStart('.').ToUpperInvariant();
            var item = new PhotoItem
            {
                IsCloud = true,
                CloudAddress = result.Address,
                FilePath = result.AbsPath,
                FileName = result.Filename,
                Format = ext.Length > 0 ? ext : "RAW",
                FileSizeBytes = result.Size,
                FileModifiedUtc = result.CapturedAtLocal?.ToUniversalTime() ?? DateTime.UtcNow,
                Rating = result.Rating,
                FlagStatus = result.Flag switch { 1 => "pick", -1 => "reject", _ => "none" },
                ColorLabel = string.IsNullOrEmpty(result.ColorLabel) ? null : result.ColorLabel,
                CaptureDate = result.CapturedAtLocal,
            };
            item.CameraModel = result.Camera is { } camera
                ? $"{camera.Make} {camera.Model}".Trim()
                : "—";
            item.LensInfo = result.Lens ?? "—";
            item.IsoDisplay = result.Iso is { } iso ? $"ISO {iso}" : "—";
            item.Aperture = result.Aperture is { } f ? $"f/{f:0.#}" : "—";
            item.ShutterSpeed = result.Shutter ?? "—";
            item.DateTaken = result.CapturedAtLocal?.ToString("yyyy-MM-dd HH:mm") ?? "—";
            item.Dimensions = $"{result.Size / (1024.0 * 1024.0):0.0} MB";
            return item;
        }

        private async Task HydrateCloudThumbnailsAsync(
            System.Collections.Generic.List<PhotoItem> items, CancellationToken ct)
        {
            var gate = new SemaphoreSlim(4);
            var tasks = items.Select(async item =>
            {
                await gate.WaitAsync(ct);
                try
                {
                    var path = await _cloud!.FetchImageAsync("thumb", item.CloudAddress!, ct);
                    if (path != null)
                        App.MainDispatcherQueue?.TryEnqueue(() =>
                            item.ThumbnailPath = new Uri(path).AbsoluteUri);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    DiagLog.Write($"[cloud] thumb failed for {item.FileName}: {ex.Message}");
                }
                finally
                {
                    gate.Release();
                }
            });
            await Task.WhenAll(tasks);
        }

        /// <summary>Preview-screen image for a cloud asset: the server's 1280px
        /// AVIF preview, cached locally.</summary>
        private void RequestCloudPreview(PhotoItem photo)
        {
            _ = Task.Run(async () =>
            {
                var path = await _cloud!.FetchImageAsync(
                    "preview", photo.CloudAddress!, CancellationToken.None);
                if (path != null)
                    OnUi(() => photo.PreviewPath = new Uri(path).AbsoluteUri);
            });
        }

        // --- Download-to-edit (#2588) ---

        /// <summary>Server sidecar for the open cloud photo, parsed with
        /// passthrough intact so the full-document POST on flush preserves
        /// server-side metadata this app doesn't model.</summary>
        private Services.Xmp.XmpSidecarDocument? _cloudDoc;
        /// <summary>Cloud photo whose developed preview should re-publish when
        /// the session moves off it (set on every cloud adjustment flush).</summary>
        private PhotoItem? _cloudPreviewPending;

        /// <summary>Fetch + apply the server sidecar after a cloud photo opens.
        /// No sidecar (404) keeps the default state.</summary>
        private async Task LoadCloudSidecarAsync(PhotoItem photo)
        {
            if (_cloud == null)
                return;
            try
            {
                var xml = await _cloud.GetXmpAsync(photo.FilePath, CancellationToken.None);
                if (xml == null || !ReferenceEquals(_openPhoto, photo))
                    return;
                var doc = Services.Xmp.XmpParser.Parse(xml);
                OnUi(() =>
                {
                    if (!ReferenceEquals(_openPhoto, photo))
                        return;
                    _cloudDoc = doc;
                    Adjustments = doc.Adjustments;
                    _originalModel = Adjustments.Clone();
                    _undoBaseline = Adjustments.Clone();
                    if (doc.Rating is { } rating) photo.Rating = rating;
                    if (doc.Flag is { } flag) photo.FlagStatus = flag;
                    if (doc.ColorLabel != null) photo.ColorLabel = doc.ColorLabel;
                    SyncSlidersFromModel();
                    Renderer.RequestRender(Adjustments.Clone());
                });
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[cloud] sidecar fetch failed for {photo.FileName}: {ex.Message}");
            }
        }

        /// <summary>Edit entry for a cloud asset: stream the original into the
        /// local cache (with progress), then run the normal decode. Selection
        /// changes mid-download are abandoned quietly.</summary>
        private async Task DownloadThenDecodeAsync(PhotoItem photo)
        {
            if (_cloud == null)
            {
                DecodeStatus = "Not connected to Maple Cloud.";
                return;
            }
            IsDecoding = true;
            DecodeStatus = $"Downloading {photo.FileName}…";
            try
            {
                var lastPercent = -1;
                var path = await _cloud.DownloadOriginalAsync(
                    photo.CloudAddress!, photo.FilePath, photo.FileSizeBytes,
                    (received, total) =>
                    {
                        if (total <= 0)
                            return;
                        var percent = (int)(received * 100 / total);
                        if (percent == lastPercent)
                            return;
                        lastPercent = percent;
                        OnUi(() =>
                        {
                            if (ReferenceEquals(SelectedPhoto, photo) && _decodedPhoto == null)
                                DecodeStatus = $"Downloading {photo.FileName}… {percent}%";
                        });
                    },
                    CancellationToken.None);
                if (!ReferenceEquals(SelectedPhoto, photo))
                    return;
                if (path == null)
                {
                    IsDecoding = false;
                    DecodeStatus = "Download failed — see maple.log";
                    return;
                }
                photo.LocalCachePath = path;
                _decodedPhoto = photo;
                DecodeCurrent(photo);
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[cloud] original download failed for {photo.FileName}: {ex.Message}");
                if (ReferenceEquals(SelectedPhoto, photo))
                {
                    IsDecoding = false;
                    DecodeStatus = $"Download failed: {ex.Message}";
                }
            }
        }

        /// <summary>Cloud flush path: fold the session state into the fetched
        /// server document (passthrough intact) and overwrite the server
        /// sidecar. Also arms the developed-preview re-publish.</summary>
        private void PushCloudSidecar(PhotoItem photo)
        {
            if (_cloud == null)
                return;
            var doc = _cloudDoc ?? new Services.Xmp.XmpSidecarDocument();
            doc.Adjustments = Adjustments.Clone();
            doc.Rating = photo.Rating;
            doc.Flag = photo.FlagStatus;
            doc.ColorLabel = photo.ColorLabel;
            _cloudDoc = doc;
            _cloudPreviewPending = photo;
            var xml = Services.Xmp.XmpWriter.Serialize(doc);
            var serverPath = photo.FilePath;
            _ = Task.Run(async () =>
            {
                if (!await _cloud.PostXmpAsync(serverPath, xml, CancellationToken.None))
                    OnUi(() => CloudStatus = "Sidecar sync failed — see maple.log");
            });
        }

        /// <summary>Develop + publish the edited asset's preview when leaving
        /// it (the web publishes on idle/exit; this is the switch-away moment).
        /// Best-effort — a failure only logs.</summary>
        private void PublishPendingCloudPreview()
        {
            var photo = _cloudPreviewPending;
            _cloudPreviewPending = null;
            if (photo?.LocalCachePath == null || _cloud == null)
                return;
            var doc = _cloudDoc;
            var cloud = _cloud;
            _ = Task.Run(async () =>
            {
                var xmpTemp = System.IO.Path.Combine(
                    System.IO.Path.GetTempPath(), $"maple-preview-{Guid.NewGuid():N}.xmp");
                var jpegTemp = System.IO.Path.Combine(
                    System.IO.Path.GetTempPath(), $"maple-preview-{Guid.NewGuid():N}.jpg");
                try
                {
                    System.IO.File.WriteAllText(xmpTemp, Services.Xmp.XmpWriter.Serialize(
                        doc ?? new Services.Xmp.XmpSidecarDocument()));
                    var rc = Native.RawFfi.maple_render_develop_jpeg_to_file(
                        photo.LocalCachePath!, xmpTemp, 1280, 82, jpegTemp);
                    if (rc != 0)
                    {
                        DiagLog.Write($"[cloud] preview develop failed rc={rc}: {Native.RawFfi.LastError()}");
                        return;
                    }
                    var bytes = await System.IO.File.ReadAllBytesAsync(jpegTemp);
                    await cloud.PublishPreviewAsync(photo.FilePath, bytes, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    DiagLog.Write($"[cloud] preview publish failed for {photo.FileName}: {ex.Message}");
                }
                finally
                {
                    try { System.IO.File.Delete(xmpTemp); } catch { /* best effort */ }
                    try { System.IO.File.Delete(jpegTemp); } catch { /* best effort */ }
                }
            });
        }

        /// <summary>Push a cloud asset's culling change to the server
        /// (POST /api/xmp/batch merges into the server-side sidecar).</summary>
        private void PushCloudCulling(PhotoItem photo)
        {
            if (_cloud == null || photo.CloudAddress == null)
                return;
            var rating = photo.Rating;
            var flag = photo.FlagStatus;
            var label = photo.ColorLabel;
            _ = Task.Run(() => _cloud.WriteCullingAsync(
                photo.CloudAddress, rating, flag, label, CancellationToken.None));
        }
    }
}
