AMSMB2 4.0.3, upstream commit `1726aaaf7adf63d7d1d2a0c5d1b0e635028215c0` from https://github.com/amosavian/AMSMB2. Its libsmb2 submodule is `aff9fa6ba9f41cfd3c15d184554601ec3f6d8d03`. Upstream MIT and libsmb2 licensing are retained.

Maple #4065 needs a connected-client read/modify/publish operation that holds server-enforced exclusive ownership and atomically replaces an existing XMP. Upstream exposes exclusive-create writes and non-replacing rename; neither can safely publish a second sidecar save. The behavioral patch adds only that concrete publication operation. Upstream Swift API names and formatting are preserved under the same vendor exemption as other imported dependencies. No existing move/rename collision behavior changes.

Update this copy by replacing the upstream sources at a reviewed revision and reapplying the documented operation, then run real SMB publication/concurrency/reconnect regressions.

Maple #4110 also explicitly closes streamed read handles before announcing EOF/error, so an awaiting consumer cannot observe completion while the C file handle is still owned by the stream. Maple source disconnect drains queued SDK operations before context teardown; full-file identity streaming is only started on the fallback path. The original #4093 FILE_CLOSED attribution remains separate from these demonstrated lifetime corrections.
