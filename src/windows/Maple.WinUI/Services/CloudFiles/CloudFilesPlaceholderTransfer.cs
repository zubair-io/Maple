using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Maple.WinUI.Services.CloudFiles
{
    internal static class CloudFilesPlaceholderTransfer
    {
        internal static bool TransferPage(
            CfApi.CF_CALLBACK_INFO info, IReadOnlyList<PlaceholderEntry> entries, int totalCount)
        {
            if (entries.Count == 0)
                return true;

            var pins = new List<GCHandle>(entries.Count * 2 + 1);
            var infos = new CfApi.CF_PLACEHOLDER_CREATE_INFO[entries.Count];
            try
            {
                for (var i = 0; i < entries.Count; i++)
                {
                    var entry = entries[i];
                    var nameHandle = GCHandle.Alloc(Encoding.Unicode.GetBytes(entry.Name + "\0"), GCHandleType.Pinned);
                    var identityBytes = Encoding.Unicode.GetBytes(entry.Address);
                    var idHandle = GCHandle.Alloc(identityBytes, GCHandleType.Pinned);
                    pins.Add(nameHandle);
                    pins.Add(idHandle);
                    var time = entry.MtimeUtc.ToFileTimeUtc();
                    infos[i] = new CfApi.CF_PLACEHOLDER_CREATE_INFO
                    {
                        RelativeFileName = nameHandle.AddrOfPinnedObject(),
                        FileIdentity = idHandle.AddrOfPinnedObject(),
                        FileIdentityLength = (uint)identityBytes.Length,
                        Flags = CfApi.CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC,
                        FsMetadata = new CfApi.CF_FS_METADATA
                        {
                            FileSize = entry.IsDirectory ? 0 : entry.Size,
                            BasicInfo = new CfApi.FILE_BASIC_INFO
                            {
                                CreationTime = time,
                                LastAccessTime = time,
                                LastWriteTime = time,
                                ChangeTime = time,
                                FileAttributes = entry.IsDirectory
                                    ? 0x10u /* FILE_ATTRIBUTE_DIRECTORY */
                                    : 0x80u /* FILE_ATTRIBUTE_NORMAL */,
                            },
                        },
                    };
                }

                var arrayHandle = GCHandle.Alloc(infos, GCHandleType.Pinned);
                pins.Add(arrayHandle);
                var opInfo = OperationInfo(info);
                var opParams = new CfApi.CF_OPERATION_PARAMETERS_TRANSFER_PLACEHOLDERS
                {
                    ParamSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_PARAMETERS_TRANSFER_PLACEHOLDERS>(),
                    CompletionStatus = CfApi.STATUS_SUCCESS,
                    PlaceholderTotalCount = totalCount,
                    PlaceholderArray = arrayHandle.AddrOfPinnedObject(),
                    PlaceholderCount = (uint)entries.Count,
                };
                var hr = CfApi.CfExecuteTransferPlaceholders(ref opInfo, ref opParams);
                if (hr != 0)
                {
                    DiagLog.Write($"[cloudfiles] TRANSFER_PLACEHOLDERS 0x{hr:X8} ({entries.Count} entries)");
                    return false;
                }

                var success = true;
                for (var i = 0; i < infos.Length; i++)
                {
                    if (infos[i].Result == 0)
                        continue;
                    DiagLog.Write(
                        $"[cloudfiles] placeholder creation failed for {entries[i].Name} (0x{infos[i].Result:X8})");
                    success = false;
                }
                return success;
            }
            finally
            {
                foreach (var pin in pins)
                    pin.Free();
            }
        }

        internal static int CompleteListing(CfApi.CF_CALLBACK_INFO info, int totalCount, bool complete)
        {
            var opInfo = OperationInfo(info);
            var opParams = new CfApi.CF_OPERATION_PARAMETERS_TRANSFER_PLACEHOLDERS
            {
                ParamSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_PARAMETERS_TRANSFER_PLACEHOLDERS>(),
                Flags = complete
                    ? CfApi.CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION
                    : 0,
                CompletionStatus = complete ? CfApi.STATUS_SUCCESS : CfApi.STATUS_UNSUCCESSFUL,
                PlaceholderTotalCount = totalCount,
                PlaceholderArray = IntPtr.Zero,
                PlaceholderCount = 0,
            };
            return CfApi.CfExecuteTransferPlaceholders(ref opInfo, ref opParams);
        }

        private static CfApi.CF_OPERATION_INFO OperationInfo(CfApi.CF_CALLBACK_INFO info) =>
            new()
            {
                StructSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_INFO>(),
                Type = CfApi.CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS,
                ConnectionKey = info.ConnectionKey,
                TransferKey = info.TransferKey,
                RequestKey = info.RequestKey,
                CorrelationVector = info.CorrelationVector,
            };
    }
}
