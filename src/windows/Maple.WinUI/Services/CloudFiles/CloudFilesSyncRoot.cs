// Maple Cloud sync root (#2589) — Maple Cloud as a folder in File
// Explorer, the Windows counterpart of the Apple File Provider extension.
//
// Registers `%USERPROFILE%\Maple Cloud` as a Cloud Files API sync root and
// serves two callbacks:
//
//   FETCH_PLACEHOLDERS — on-demand directory population. The sync root
//     lists one directory per registered cloud library
//     (GET /api/folders); every level below comes from GET /api/fs/dir —
//     the same walk the in-app browser, web, and the Apple File Provider
//     use. Each placeholder's FileIdentity is the entry's absolute server
//     path, so a callback can address the server without any local state.
//
//   FETCH_DATA — on-demand hydration. Opening a placeholder streams the
//     original through GET /api/fs/raw straight into CfExecute
//     TRANSFER_DATA chunks; nothing spools to disk first. Explorer's
//     pin-for-offline ("Always keep on this device") rides the same
//     callback — the platform requests full hydration, which the FULL
//     hydration policy already makes the only mode.
//
// v1 is browse/hydrate/pin only: Explorer-initiated deletes, renames and
// writes are not propagated to the server (no NOTIFY_* callbacks are
// registered, so the platform applies them locally like any normal
// folder — they simply don't sync). Write-back is a deliberate follow-up,
// not an oversight: the delete plumbing exists (#2741) but wiring
// Explorer's semantics onto it deserves its own ticket.
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
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.Services.CloudFiles
{
    public sealed class CloudFilesSyncRoot : IDisposable
    {
        private static readonly Guid ProviderId = new("8f1e1a5e-70b1-4bda-9d47-1f3b8a2ce589");

        private readonly Func<CloudClient?> _client;
        private readonly object _gate = new();
        private readonly ConcurrentDictionary<long, CancellationTokenSource> _fetches = new();

        // The callback delegates must stay rooted for the connection's
        // lifetime — cldapi holds only the raw function pointers.
        private readonly CfApi.CfCallback _fetchPlaceholders;
        private readonly CfApi.CfCallback _fetchData;
        private readonly CfApi.CfCallback _cancelFetchData;

        private long _connectionKey;
        private bool _connected;

        public static string SyncRootPath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Maple Cloud");

        public CloudFilesSyncRoot(Func<CloudClient?> client)
        {
            _client = client;
            _fetchPlaceholders = OnFetchPlaceholders;
            _fetchData = OnFetchData;
            _cancelFetchData = OnCancelFetchData;
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
                    Directory.CreateDirectory(SyncRootPath);

                    var name = Marshal.StringToHGlobalUni("Maple");
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
                            PopulationPrimary = CfApi.CF_POPULATION_POLICY_PARTIAL,
                            InSync = CfApi.CF_INSYNC_POLICY_NONE,
                            HardLink = CfApi.CF_HARDLINK_POLICY_NONE,
                        };
                        var hr = CfApi.CfRegisterSyncRoot(
                            SyncRootPath, ref registration, ref policies, CfApi.CF_REGISTER_FLAG_UPDATE);
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
                            Type = CfApi.CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS,
                            Callback = Marshal.GetFunctionPointerForDelegate(_fetchPlaceholders),
                        },
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
                        new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE_NONE },
                    };
                    var hrConnect = CfApi.CfConnectSyncRoot(
                        SyncRootPath, table, IntPtr.Zero,
                        CfApi.CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH, out _connectionKey);
                    if (hrConnect != 0)
                    {
                        // Roll the registration back (best-effort) so a
                        // failed enable strands nothing — the same
                        // no-lying-state invariant the settings toggle keeps.
                        try { CfApi.CfUnregisterSyncRoot(SyncRootPath); } catch { /* best effort */ }
                        return $"Sync root connection failed (0x{hrConnect:X8}).";
                    }

                    _connected = true;
                    DiagLog.Write($"[cloudfiles] connected sync root at {SyncRootPath}");
                    return null;
                }
                catch (DllNotFoundException)
                {
                    return "This edition of Windows has no Cloud Files support (cldapi.dll missing).";
                }
            }
        }

        /// <summary>Disconnects and, when <paramref name="unregister"/>,
        /// removes the sync-root registration (placeholders left behind
        /// become dead files, so the folder is deleted too — everything in
        /// it is re-creatable from the server).</summary>
        public void Stop(bool unregister)
        {
            lock (_gate)
            {
                foreach (var cts in _fetches.Values)
                    cts.Cancel();
                _fetches.Clear();
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
                        CfApi.CfUnregisterSyncRoot(SyncRootPath);
                        if (Directory.Exists(SyncRootPath))
                            Directory.Delete(SyncRootPath, recursive: true);
                    }
                    catch (Exception ex)
                    {
                        DiagLog.Write($"[cloudfiles] unregister cleanup: {ex.Message}");
                    }
                }
            }
        }

        public void Dispose() => Stop(unregister: false);

        // --- FETCH_PLACEHOLDERS ---

        private void OnFetchPlaceholders(IntPtr infoPtr, IntPtr paramsPtr)
        {
            var info = Marshal.PtrToStructure<CfApi.CF_CALLBACK_INFO>(infoPtr);
            List<Entry> entries;
            try
            {
                entries = ListEntriesAsync(ReadIdentity(info)).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[cloudfiles] fetch-placeholders failed: {ex.Message}");
                entries = new List<Entry>();
            }

            var pins = new List<GCHandle>();
            var infos = new CfApi.CF_PLACEHOLDER_CREATE_INFO[Math.Max(1, entries.Count)];
            try
            {
                for (var i = 0; i < entries.Count; i++)
                {
                    var e = entries[i];
                    var nameHandle = GCHandle.Alloc(
                        Encoding.Unicode.GetBytes(e.Name + "\0"), GCHandleType.Pinned);
                    var identityBytes = Encoding.Unicode.GetBytes(e.ServerPath);
                    var idHandle = GCHandle.Alloc(identityBytes, GCHandleType.Pinned);
                    pins.Add(nameHandle);
                    pins.Add(idHandle);
                    var time = e.MtimeUtc.ToFileTimeUtc();
                    infos[i] = new CfApi.CF_PLACEHOLDER_CREATE_INFO
                    {
                        RelativeFileName = nameHandle.AddrOfPinnedObject(),
                        FileIdentity = idHandle.AddrOfPinnedObject(),
                        FileIdentityLength = (uint)identityBytes.Length,
                        Flags = CfApi.CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC,
                        FsMetadata = new CfApi.CF_FS_METADATA
                        {
                            FileSize = e.IsDirectory ? 0 : e.Size,
                            BasicInfo = new CfApi.FILE_BASIC_INFO
                            {
                                CreationTime = time,
                                LastAccessTime = time,
                                LastWriteTime = time,
                                ChangeTime = time,
                                FileAttributes = e.IsDirectory
                                    ? 0x10u /* FILE_ATTRIBUTE_DIRECTORY */
                                    : 0x80u /* FILE_ATTRIBUTE_NORMAL */,
                            },
                        },
                    };
                }

                var arrayHandle = GCHandle.Alloc(infos, GCHandleType.Pinned);
                pins.Add(arrayHandle);
                var opInfo = OperationInfo(info, CfApi.CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS);
                var opParams = new CfApi.CF_OPERATION_PARAMETERS_TRANSFER_PLACEHOLDERS
                {
                    ParamSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_PARAMETERS_TRANSFER_PLACEHOLDERS>(),
                    Flags = CfApi.CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION,
                    CompletionStatus = CfApi.STATUS_SUCCESS,
                    PlaceholderTotalCount = entries.Count,
                    PlaceholderArray = entries.Count == 0 ? IntPtr.Zero : arrayHandle.AddrOfPinnedObject(),
                    PlaceholderCount = (uint)entries.Count,
                };
                var hr = CfApi.CfExecuteTransferPlaceholders(ref opInfo, ref opParams);
                if (hr != 0)
                    DiagLog.Write($"[cloudfiles] TRANSFER_PLACEHOLDERS 0x{hr:X8} ({entries.Count} entries)");
            }
            finally
            {
                foreach (var pin in pins)
                    pin.Free();
            }
        }

        private sealed record Entry(string Name, string ServerPath, bool IsDirectory, long Size, DateTime MtimeUtc);

        /// <summary>Directory listing behind a placeholder identity: the sync
        /// root itself (empty identity) lists the registered libraries; any
        /// other identity is an absolute server directory path listed via
        /// /api/fs/dir, cursor-paged to completion.</summary>
        private async Task<List<Entry>> ListEntriesAsync(string identity)
        {
            var entries = new List<Entry>();
            var client = _client();
            if (client is not { IsAuthenticated: true })
                return entries;

            if (identity.Length == 0)
            {
                var folders = await client.GetFoldersAsync(CancellationToken.None).ConfigureAwait(false);
                foreach (var folder in folders ?? Array.Empty<CloudFolder>())
                    entries.Add(new Entry(
                        SanitizeName(folder.DisplayName), folder.Path, true, 0, DateTime.UtcNow));
                return entries;
            }

            string? cursor = null;
            do
            {
                var page = await client.ListDirAsync(identity, cursor, 500, CancellationToken.None)
                    .ConfigureAwait(false);
                if (page == null)
                    break;
                foreach (var dir in page.Dirs)
                {
                    // The server hides its own bookkeeping dirs, but be
                    // defensive: a `.maple` placeholder would invite Explorer
                    // into the trash/previews store.
                    if (dir.Name.StartsWith('.'))
                        continue;
                    entries.Add(new Entry(
                        SanitizeName(dir.Name), dir.Path, true, 0, ParseMtime(dir.Mtime)));
                }
                foreach (var img in page.Images)
                    entries.Add(new Entry(
                        SanitizeName(img.Name), img.Path, false, img.Size, ParseMtime(img.Mtime)));
                cursor = page.NextCursor;
            } while (!string.IsNullOrEmpty(cursor));
            return entries;
        }

        // --- FETCH_DATA ---

        private void OnFetchData(IntPtr infoPtr, IntPtr paramsPtr)
        {
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
        /// (which ends at EOF, where the platform accepts a short
        /// tail).</summary>
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

            // The FULL hydration policy makes every request start at 0, and
            // the sequential streaming below depends on that. Guard the
            // assumption: a non-zero required offset (e.g. a future policy
            // change, or a restarted partial hydration) must fail cleanly
            // rather than deliver bytes at wrong offsets and corrupt the
            // read.
            if (fetch.RequiredFileOffset != 0)
            {
                DiagLog.Write(
                    $"[cloudfiles] unsupported partial hydration request at offset {fetch.RequiredFileOffset}");
                CompleteTransfer(info, fetch.RequiredFileOffset, fetch.RequiredLength,
                    CfApi.STATUS_UNSUCCESSFUL);
                return;
            }

            using var response = await client.OpenOriginalAsync(identity, ct).ConfigureAwait(false);
            if (response == null)
            {
                CompleteTransfer(info, fetch.RequiredFileOffset, fetch.RequiredLength,
                    CfApi.STATUS_UNSUCCESSFUL);
                return;
            }

            await using var body = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var buffer = new byte[1 << 20];
            long delivered = 0;
            var filled = 0;
            while (true)
            {
                var read = await body.ReadAsync(
                    buffer.AsMemory(filled, buffer.Length - filled), ct).ConfigureAwait(false);
                if (read > 0)
                {
                    filled += read;
                    if (filled < buffer.Length)
                        continue;
                }

                // Flush the aligned prefix; at end of stream flush everything
                // (a short tail is legal only when it reaches EOF).
                var flush = read > 0
                    ? filled - filled % CfApi.HydrationChunkAlignment
                    : filled;
                if (flush > 0)
                {
                    DeliverChunk(info, buffer, flush, delivered);
                    delivered += flush;
                    Buffer.BlockCopy(buffer, flush, buffer, 0, filled - flush);
                    filled -= flush;
                }
                if (read <= 0)
                    break;
            }
            DiagLog.Write($"[cloudfiles] hydrated {Path.GetFileName(identity.Replace('\\', '/'))} ({delivered} bytes)");
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

        private static DateTime ParseMtime(string? mtime) =>
            DateTime.TryParse(mtime, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var t)
                ? DateTime.SpecifyKind(t, DateTimeKind.Utc)
                : DateTime.UtcNow;

        private static string SanitizeName(string name)
        {
            var invalid = Path.GetInvalidFileNameChars();
            return name.Any(c => invalid.Contains(c))
                ? new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray())
                : name;
        }
    }
}
