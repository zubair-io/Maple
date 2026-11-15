using System;
using System.Runtime.InteropServices;
using System.Threading;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.Services.CloudFiles
{
    public sealed partial class CloudFilesSyncRoot
    {
        internal Action<int, int, int>? AckResultForTest { get; set; }
        internal Action<int>? NotifyEnteredForTest { get; set; }
        internal int[]? CallbackTypesForTest { get; private set; }

        private void OnNotifyDelete(IntPtr infoPtr, IntPtr paramsPtr)
        {
            NotifyEnteredForTest?.Invoke(CfApi.CF_CALLBACK_TYPE_NOTIFY_DELETE);
            var info = Marshal.PtrToStructure<CfApi.CF_CALLBACK_INFO>(infoPtr);
            // Maple removes placeholders itself (the disable sweep, server-side
            // deletes); answering those like a user's delete would trash the
            // server copy of everything it cleans up.
            if (IsOwnProcess(info))
            {
                Ack(info, CfApi.CF_OPERATION_TYPE_ACK_DELETE, CfApi.STATUS_SUCCESS);
                return;
            }
            var allowed = false;
            try
            {
                var address = ReadIdentity(info);
                var folders = _client()?.GetFoldersAsync(CancellationToken.None).GetAwaiter().GetResult();
                if (folders != null && CloudFilesAddress.TryResolve(address, folders, out var resolved)
                    && resolved.RelativePath.Length > 0)
                {
                    var client = _client();
                    var flags = (uint)Marshal.ReadInt32(paramsPtr, CfApi.CF_CALLBACK_PARAMETERS_FLAGS_OFFSET);
                    var isDirectory = (flags & CfApi.CF_CALLBACK_DELETE_FLAG_IS_DIRECTORY) != 0;
                    if (client != null && isDirectory)
                        allowed = client.TrashCloudFolderAsync(resolved.FolderId, resolved.RelativePath, CancellationToken.None).GetAwaiter().GetResult();
                    else if (client != null)
                    {
                        var asset = client.ResolveAssetAddressAsync(resolved.Address, CancellationToken.None).GetAwaiter().GetResult();
                        allowed = asset != null
                            ? client.TrashAssetAsync(asset.Id, CancellationToken.None).GetAwaiter().GetResult()
                            : client.TrashCloudFileAsync(resolved.FolderId, resolved.RelativePath, CancellationToken.None).GetAwaiter().GetResult();
                    }
                }
            }
            catch (Exception ex) { DiagLog.Write($"[cloudfiles] delete notification failed: {ex.Message}"); }
            Ack(info, CfApi.CF_OPERATION_TYPE_ACK_DELETE, allowed ? CfApi.STATUS_SUCCESS : CfApi.STATUS_CLOUD_FILE_ACCESS_DENIED);
        }

        private void OnNotifyRename(IntPtr infoPtr, IntPtr paramsPtr)
        {
            NotifyEnteredForTest?.Invoke(CfApi.CF_CALLBACK_TYPE_NOTIFY_RENAME);
            var info = Marshal.PtrToStructure<CfApi.CF_CALLBACK_INFO>(infoPtr);
            Ack(info, CfApi.CF_OPERATION_TYPE_ACK_RENAME, CfApi.STATUS_CLOUD_FILE_ACCESS_DENIED);
        }

        private static bool IsOwnProcess(CfApi.CF_CALLBACK_INFO info) =>
            info.ProcessInfo != IntPtr.Zero &&
            Marshal.ReadInt32(info.ProcessInfo, CfApi.CF_PROCESS_INFO_PROCESS_ID_OFFSET) == Environment.ProcessId;

        private void Ack(CfApi.CF_CALLBACK_INFO info, int type, int status)
        {
            var operation = OperationInfo(info, type);
            var parameters = new CfApi.CF_OPERATION_PARAMETERS_ACK
            {
                ParamSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_PARAMETERS_ACK>(),
                CompletionStatus = status,
            };
            var hr = CfApi.CfExecuteAck(ref operation, ref parameters);
            AckResultForTest?.Invoke(type, status, hr);
            if (hr != 0) DiagLog.Write($"[cloudfiles] ACK operation {type} failed (0x{hr:X8})");
        }
    }
}
