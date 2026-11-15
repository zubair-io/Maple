// Maple Cloud sync root (#2589) — Maple Cloud as a folder in File
// Explorer, the Windows counterpart of the Apple File Provider extension.
//
// Registers `%USERPROFILE%\Maple Cloud` as a Cloud Files API sync root and
// serves two callbacks:
//
//   FETCH_PLACEHOLDERS — on-demand directory population. The sync root
//     lists one directory per registered cloud library
//     (GET /api/folders); every level below comes from the cursor-paged
//     GET /api/folder/:slug/* route. FileIdentity is a slug:relPath address.
//
//   FETCH_DATA — on-demand hydration. Opening a placeholder streams the
//     original through GET /api/image/:slug/* straight into CfExecute
//     TRANSFER_DATA chunks (CloudFilesHydration.cs); nothing spools to
//     disk first. Explorer's pin-for-offline ("Always keep on this
//     device") rides the same callback — the platform requests full
//     hydration, which the FULL hydration policy already makes the only
//     mode.
//
// The unified folder listing carries size and mtime for every file class.
// Image reads use the mirror-failing-over /api/image route; 415 responses
// fall back to /api/folders/:id/file for videos, sidecars and ordinary files.
// Hydration still uses the FULL policy and refuses nonzero-offset requests.
//
// The root also consumes the server change journal and reconciles already
// populated directories. Explorer deletes route to Maple Trash and renames
// are refused with a Cloud Files acknowledgement. Local file creation has
// no CFAPI notification in this provider, so newly copied files remain
// local; the settings UI states this explicitly. The corollary (#4756) is
// that the folder can hold the only copy of a user's file, so disabling
// the integration removes nothing but in-sync placeholders
// (CloudFilesSyncRootCleanup.cs) and enabling it never adopts a non-empty
// folder that is not already a registered sync root.
//
// Registration uses the Win32 CfRegisterSyncRoot path (not WinRT
// StorageProviderSyncRootManager, which requires package identity this
// unpackaged app doesn't have — the Dropbox model). The folder works
// fully — placeholders, cloud status icons, on-demand hydration; only the
// navigation-pane branding entry needs the packaged registration.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.Services.CloudFiles
{
    public sealed partial class CloudFilesSyncRoot : IDisposable
    {
        private static readonly Guid ProviderId = new("8f1e1a5e-70b1-4bda-9d47-1f3b8a2ce589");
        internal const string ProviderName = "Maple";

        private readonly Func<CloudClient?> _client;
        private readonly string _syncRootPath;
        private readonly object _gate = new();
        private readonly ConcurrentDictionary<long, CancellationTokenSource> _fetches = new();

        // The callback delegates must stay rooted for the connection's
        // lifetime — cldapi holds only the raw function pointers.
        private readonly CfApi.CfCallback _fetchPlaceholders;
        private readonly CfApi.CfCallback _fetchData;
        private readonly CfApi.CfCallback _cancelFetchData;
        private readonly CfApi.CfCallback _notifyDelete;
        private readonly CfApi.CfCallback _notifyRename;

        private long _connectionKey;
        private bool _connected;
        private CancellationTokenSource? _changeFeedCancellation;
        private Task? _changeFeedTask;

        public static string SyncRootPath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Maple Cloud");

        public CloudFilesSyncRoot(Func<CloudClient?> client)
            : this(client, SyncRootPath)
        {
        }

        // Internal override allows the opt-in CFAPI integration probe to
        // register a unique disposable NTFS root without touching the user's
        // production Maple Cloud directory.
        internal CloudFilesSyncRoot(Func<CloudClient?> client, string syncRootPath)
        {
            _client = client;
            _syncRootPath = Path.GetFullPath(syncRootPath);
            _fetchPlaceholders = OnFetchPlaceholders;
            _fetchData = OnFetchData;
            _cancelFetchData = OnCancelFetchData;
            _notifyDelete = OnNotifyDelete;
            _notifyRename = OnNotifyRename;
        }

        public bool IsRunning
        {
            get { lock (_gate) return _connected; }
        }

        /// <summary>Registers (idempotently) and connects the sync root.
        /// Returns null on success, or a user-presentable failure
        /// message.</summary>
        public string? Start()
        {
            lock (_gate)
            {
                if (_connected)
                    return null;
                try
                {
                    var refusal = CloudFilesSyncRootCleanup.AdoptionRefusal(
                        _syncRootPath, CloudFilesPlaceholderProbe.IsMapleSyncRoot(_syncRootPath));
                    if (refusal != null)
                        return refusal;
                    Directory.CreateDirectory(_syncRootPath);

                    var name = Marshal.StringToHGlobalUni(ProviderName);
                    var version = Marshal.StringToHGlobalUni("1.0");
                    try
                    {
                        var registration = new CfApi.CF_SYNC_REGISTRATION
                        {
                            StructSize = (uint)Marshal.SizeOf<CfApi.CF_SYNC_REGISTRATION>(),
                            ProviderName = name,
                            ProviderVersion = version,
                            ProviderId = ProviderId,
                        };
                        var policies = new CfApi.CF_SYNC_POLICIES
                        {
                            StructSize = (uint)Marshal.SizeOf<CfApi.CF_SYNC_POLICIES>(),
                            HydrationPrimary = CfApi.CF_HYDRATION_POLICY_FULL,
                            PopulationPrimary = CfApi.CF_POPULATION_POLICY_FULL,
                            InSync = CfApi.CF_INSYNC_POLICY_NONE,
                            HardLink = CfApi.CF_HARDLINK_POLICY_NONE,
                        };
                        var hr = CfApi.CfRegisterSyncRoot(
                            _syncRootPath, ref registration, ref policies, CfApi.CF_REGISTER_FLAG_UPDATE);
                        if (hr != 0)
                            return $"Sync root registration failed (0x{hr:X8}).";
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(name);
                        Marshal.FreeHGlobal(version);
                    }

                    var table = new[]
                    {
                        new CfApi.CF_CALLBACK_REGISTRATION
                        {
                            Type = CfApi.CF_CALLBACK_TYPE_FETCH_DATA,
                            Callback = Marshal.GetFunctionPointerForDelegate(_fetchData),
                        },
                        new CfApi.CF_CALLBACK_REGISTRATION
                        {
                            Type = CfApi.CF_CALLBACK_TYPE_CANCEL_FETCH_DATA,
                            Callback = Marshal.GetFunctionPointerForDelegate(_cancelFetchData),
                        },
                        new CfApi.CF_CALLBACK_REGISTRATION
                        {
                            Type = CfApi.CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS,
                            Callback = Marshal.GetFunctionPointerForDelegate(_fetchPlaceholders),
                        },
                        new CfApi.CF_CALLBACK_REGISTRATION
                        {
                            Type = CfApi.CF_CALLBACK_TYPE_NOTIFY_DELETE,
                            Callback = Marshal.GetFunctionPointerForDelegate(_notifyDelete),
                        },
                        new CfApi.CF_CALLBACK_REGISTRATION
                        {
                            Type = CfApi.CF_CALLBACK_TYPE_NOTIFY_RENAME,
                            Callback = Marshal.GetFunctionPointerForDelegate(_notifyRename),
                        },
                        new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE_NONE },
                    };
                    CallbackTypesForTest = table.Select(registration => registration.Type).ToArray();
                    var hrConnect = CfApi.CfConnectSyncRoot(
                        _syncRootPath, table, IntPtr.Zero,
                        CfApi.CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH | CfApi.CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO,
                        out _connectionKey);
                    if (hrConnect != 0)
                    {
                        // Roll the registration back (best-effort) so a
                        // failed enable strands nothing — the same
                        // no-lying-state invariant the settings toggle keeps.
                        try { CfApi.CfUnregisterSyncRoot(_syncRootPath); } catch { /* best effort */ }
                        return $"Sync root connection failed (0x{hrConnect:X8}).";
                    }

                    _connected = true;
                    _changeFeedCancellation = new CancellationTokenSource();
                    var feedToken = _changeFeedCancellation.Token;
                    _changeFeedTask = Task.Run(() => RunChangeFeedAsync(feedToken));
                    DiagLog.Write($"[cloudfiles] connected sync root at {_syncRootPath}");
                    return null;
                }
                catch (DllNotFoundException)
                {
                    return "This edition of Windows has no Cloud Files support (cldapi.dll missing).";
                }
            }
        }

        /// <summary>Disconnects and, when <paramref name="unregister"/>,
        /// removes the sync-root registration. Placeholders left behind
        /// would become dead files, so the in-sync ones are deleted; every
        /// other item — Explorer-side writes, edited hydrated copies,
        /// anything whose state can't be read — stays, and the folder is
        /// removed only once it is empty (#4756). The sweep runs first,
        /// while still connected and registered: a never-opened directory
        /// can only be enumerated while FETCH_PLACEHOLDERS is served, and
        /// unregistering turns hydrated placeholders into plain files the
        /// probe would then keep. Unregistration runs whatever the sweep
        /// did, so a disable never strands a registered root.</summary>
        public void Stop(bool unregister)
        {
            lock (_gate)
            {
                foreach (var cts in _fetches.Values)
                    cts.Cancel();
                _fetches.Clear();
                var feedTask = _changeFeedTask;
                _changeFeedCancellation?.Cancel();
                try { feedTask?.GetAwaiter().GetResult(); }
                catch (OperationCanceledException) { }
                catch (Exception ex) { DiagLog.Write($"[cloudfiles] change-feed shutdown: {ex.Message}"); }
                _changeFeedCancellation?.Dispose();
                _changeFeedCancellation = null;
                _changeFeedTask = null;
                if (unregister)
                    SweepSafely();
                if (_connected)
                {
                    CfApi.CfDisconnectSyncRoot(_connectionKey);
                    _connected = false;
                    DiagLog.Write("[cloudfiles] disconnected sync root");
                }
                if (unregister)
                {
                    try
                    {
                        var hr = CfApi.CfUnregisterSyncRoot(_syncRootPath);
                        DiagLog.Write($"[cloudfiles] unregistered sync root (0x{hr:X8})");
                    }
                    catch (Exception ex)
                    {
                        DiagLog.Write($"[cloudfiles] unregister failed: {ex.Message}");
                    }
                }
            }
        }

        private void SweepSafely()
        {
            try
            {
                var swept = CloudFilesSyncRootCleanup.Sweep(_syncRootPath, CloudFilesPlaceholderProbe.Probes);
                DiagLog.Write(
                    $"[cloudfiles] swept sync root: removed {swept.Removed} placeholders, kept {swept.Preserved} local items");
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[cloudfiles] sweep aborted, folder left in place: {ex.Message}");
            }
        }

        public void Dispose() => Stop(unregister: false);

        // --- FETCH_PLACEHOLDERS ---

        private void OnFetchPlaceholders(IntPtr infoPtr, IntPtr paramsPtr)
        {
            NotifyEnteredForTest?.Invoke(CfApi.CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS);
            var info = Marshal.PtrToStructure<CfApi.CF_CALLBACK_INFO>(infoPtr);
            var reconciler = ExistingPlaceholderReconciler(info);
            var stream = ListEntriesAsync(ReadIdentity(info), (entries, totalCount) =>
            {
                var missing = reconciler == null ? entries : reconciler.MissingFrom(entries);
                return missing != null && CloudFilesPlaceholderTransfer.TransferPage(info, missing, totalCount);
            }).GetAwaiter().GetResult();
            var complete = stream.Complete && (reconciler == null || reconciler.TryRemoveUnlisted());
            var hr = CloudFilesPlaceholderTransfer.CompleteListing(info, stream.TransferredCount, complete);
            if (hr != 0)
                DiagLog.Write($"[cloudfiles] TRANSFER_PLACEHOLDERS completion 0x{hr:X8}");
        }

        /// <summary>Directory listing behind a placeholder identity: the sync
        /// root itself (empty identity) lists registered libraries; nested
        /// identities resolve to slug:relPath and use the enriched folder route.</summary>
        private async Task<PlaceholderStreamResult> ListEntriesAsync(
            string identity, Func<IReadOnlyList<PlaceholderEntry>, int, bool> transferPage)
        {
            var client = _client();
            if (client is not { IsAuthenticated: true })
                return new(false, 0);

            if (identity.Length == 0)
                return await CloudFilesListing.StreamPagesAsync(async _ =>
                {
                    var folders = await client.GetFoldersAsync(CancellationToken.None).ConfigureAwait(false);
                    return folders == null
                        ? null
                        : new PlaceholderPage(
                            folders.Select(folder => new PlaceholderEntry(
                                SanitizeName(folder.DisplayName), folder.Slug + ":", true, 0, DateTime.UnixEpoch)).ToList(),
                            null);
                }, transferPage).ConfigureAwait(false);

            var registered = await client.GetFoldersAsync(CancellationToken.None).ConfigureAwait(false);
            if (registered == null ||
                !CloudFilesAddress.TryResolve(identity, registered, out var address))
                return new(false, 0);

            return await CloudFilesListing.StreamPagesAsync(async cursor =>
            {
                var page = await client.ListFolderAddressAsync(address.Address, cursor, 500, CancellationToken.None)
                    .ConfigureAwait(false);
                if (page == null)
                    return null;
                var entries = CloudFilesAddress.MapListing(page)
                    .Where(entry => !entry.Name.StartsWith('.'))
                    .Select(entry => entry with { Name = SanitizeName(entry.Name) })
                    .ToList();
                return new PlaceholderPage(entries, page.NextCursor);
            }, transferPage).ConfigureAwait(false);
        }

        // --- FETCH_DATA ---

        private void OnFetchData(IntPtr infoPtr, IntPtr paramsPtr)
        {
            NotifyEnteredForTest?.Invoke(CfApi.CF_CALLBACK_TYPE_FETCH_DATA);
            var info = Marshal.PtrToStructure<CfApi.CF_CALLBACK_INFO>(infoPtr);
            var fetch = Marshal.PtrToStructure<CfApi.CF_CALLBACK_PARAMETERS_FETCH_DATA>(paramsPtr);
            var cts = new CancellationTokenSource();
            _fetches[info.TransferKey] = cts;
            try
            {
                HydrateAsync(info, fetch, cts.Token).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[cloudfiles] hydration failed: {ex.Message}");
                CompleteTransfer(info, fetch.RequiredFileOffset, fetch.RequiredLength,
                    CfApi.STATUS_UNSUCCESSFUL);
            }
            finally
            {
                _fetches.TryRemove(info.TransferKey, out _);
                cts.Dispose();
            }
        }

        private void OnCancelFetchData(IntPtr infoPtr, IntPtr paramsPtr)
        {
            var info = Marshal.PtrToStructure<CfApi.CF_CALLBACK_INFO>(infoPtr);
            if (_fetches.TryGetValue(info.TransferKey, out var cts))
                cts.Cancel();
        }

        /// <summary>Streams the required range from GET /api/fs/raw into
        /// TRANSFER_DATA chunks. The FULL hydration policy makes the
        /// required range the whole file, so a plain sequential body read
        /// covers it; every delivered chunk is 4096-aligned except the last
        /// (which ends at EOF, where the platform accepts a short tail) —
        /// the loop itself is <see cref="CloudFilesHydration.StreamAlignedAsync"/>.</summary>
        private async Task HydrateAsync(
            CfApi.CF_CALLBACK_INFO info, CfApi.CF_CALLBACK_PARAMETERS_FETCH_DATA fetch, CancellationToken ct)
        {
            var client = _client();
            var identity = ReadIdentity(info);
            if (client is not { IsAuthenticated: true } || identity.Length == 0)
            {
                CompleteTransfer(info, fetch.RequiredFileOffset, fetch.RequiredLength,
                    CfApi.STATUS_UNSUCCESSFUL);
                return;
            }

            if (!CloudFilesHydration.IsSupportedRequest(fetch.RequiredFileOffset))
            {
                DiagLog.Write(
                    $"[cloudfiles] unsupported partial hydration request at offset {fetch.RequiredFileOffset}");
                CompleteTransfer(info, fetch.RequiredFileOffset, fetch.RequiredLength,
                    CfApi.STATUS_UNSUCCESSFUL);
                return;
            }

            var folders = await client.GetFoldersAsync(ct).ConfigureAwait(false);
            if (folders == null || !CloudFilesAddress.TryResolve(identity, folders, out var address))
            {
                CompleteTransfer(info, fetch.RequiredFileOffset, fetch.RequiredLength,
                    CfApi.STATUS_UNSUCCESSFUL);
                return;
            }

            using var response = await client.OpenOriginalAsync(
                address.Address, address.FolderId, address.RelativePath, ct).ConfigureAwait(false);
            if (response == null)
            {
                CompleteTransfer(info, fetch.RequiredFileOffset, fetch.RequiredLength,
                    CfApi.STATUS_UNSUCCESSFUL);
                return;
            }

            await using var body = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var delivered = await CloudFilesHydration.StreamAlignedAsync(
                body, CfApi.HydrationChunkAlignment,
                (buffer, length, offset) => DeliverChunk(info, buffer, length, offset), ct)
                .ConfigureAwait(false);
            DiagLog.Write($"[cloudfiles] hydrated {Path.GetFileName(address.RelativePath)} ({delivered} bytes)");
        }

        private void DeliverChunk(CfApi.CF_CALLBACK_INFO info, byte[] data, int length, long offset)
        {
            var handle = GCHandle.Alloc(data, GCHandleType.Pinned);
            try
            {
                var opInfo = OperationInfo(info, CfApi.CF_OPERATION_TYPE_TRANSFER_DATA);
                var opParams = new CfApi.CF_OPERATION_PARAMETERS_TRANSFER_DATA
                {
                    ParamSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_PARAMETERS_TRANSFER_DATA>(),
                    CompletionStatus = CfApi.STATUS_SUCCESS,
                    Buffer = handle.AddrOfPinnedObject(),
                    Offset = offset,
                    Length = length,
                };
                var hr = CfApi.CfExecuteTransferData(ref opInfo, ref opParams);
                if (hr != 0)
                    throw new InvalidOperationException($"TRANSFER_DATA 0x{hr:X8} at {offset}+{length}");
            }
            finally
            {
                handle.Free();
            }
        }

        /// <summary>Reports a terminal status over the required range —
        /// the platform releases the waiting reader instead of hanging it
        /// until timeout.</summary>
        private static void CompleteTransfer(
            CfApi.CF_CALLBACK_INFO info, long offset, long length, int status)
        {
            var opInfo = OperationInfo(info, CfApi.CF_OPERATION_TYPE_TRANSFER_DATA);
            var opParams = new CfApi.CF_OPERATION_PARAMETERS_TRANSFER_DATA
            {
                ParamSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_PARAMETERS_TRANSFER_DATA>(),
                CompletionStatus = status,
                Buffer = IntPtr.Zero,
                Offset = offset,
                Length = length,
            };
            CfApi.CfExecuteTransferData(ref opInfo, ref opParams);
        }

        private static CfApi.CF_OPERATION_INFO OperationInfo(CfApi.CF_CALLBACK_INFO info, int type) =>
            new()
            {
                StructSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_INFO>(),
                Type = type,
                ConnectionKey = info.ConnectionKey,
                TransferKey = info.TransferKey,
                RequestKey = info.RequestKey,
            };

        private static string ReadIdentity(CfApi.CF_CALLBACK_INFO info) =>
            info.FileIdentity == IntPtr.Zero || info.FileIdentityLength == 0
                ? string.Empty
                : Marshal.PtrToStringUni(info.FileIdentity, (int)(info.FileIdentityLength / 2)) ?? string.Empty;

        private static string SanitizeName(string name)
        {
            var invalid = Path.GetInvalidFileNameChars();
            return name.Any(c => invalid.Contains(c))
                ? new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray())
                : name;
        }
    }
}
