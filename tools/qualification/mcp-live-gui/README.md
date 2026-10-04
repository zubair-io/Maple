# Live MCP and GUI Undo qualification (#4140)

This complements the required `AgentEditServiceTests` real stdio/socket/XMP regression with a visible macOS app workflow. It uses an owned signed Debug app copy and copied fixture, never the production app or its App Group, defaults, authentication or originals. Release builds have no qualification launch path.

Build the Debug Maple app with `xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple -destination platform=macOS -derivedDataPath <owned-derived-directory> build-for-testing`, then build the actual stdio bridge with `swift build --package-path src/apple/Packages/MapleMCP --configuration release --product maple-mcp`. The app requires fresh release Rust xcframework bindings as documented in AGENTS.md.

Prepare a new owned copy with an existing authorized Developer ID identity:

```sh
python3 tools/qualification/mcp-live-gui/prepare.py \
  --app <owned-derived-directory>/Build/Products/Debug/Maple.app \
  --output <new-owned-copy-directory> \
  --identity '<existing Developer ID Application identity>' \
  --fixture src/apple/Packages/MapleCore/Tests/MapleCoreTests/Fixtures/portrait-skin-test.png
```

The preparation records the original and copy hashes and identical compiled Mach-O sections, removes extensions and URL/document registrations only from the copy, and signs it with limited sandbox entitlements without production application or keychain groups. It stages the fixture and a real zero-exposure XMP in the new bundle's private container. Existing evidence directories are rejected rather than overwritten.

Launch only the executable recorded in `provenance.json`, with its recorded fixture directory as `MAPLE_UITEST_FIXTURE_ROOT`, its fixture basename as `MAPLE_UITEST_FIXTURE`, and `--maple-agent-ui-qualification`. These are the existing valid-fixture harness variables. The DEBUG macOS guard rejects a missing fixture and starts the existing internal controller on the private `agent.sock`, skipping production group/default publication and preference-driven socket startup.

Using the actual built bridge, run `probe.py --bridge <maple-mcp> --copy <owned-copy-directory> --evidence <owned-evidence-directory> --phase before`, then `--phase edit`. Each probe initializes MCP over stdio, invokes the real running app service, rejects tool errors, and verifies the original PNG hash. Capture the actual app accessibility tree and screenshot before and after the edit using authorized computer-use tooling. Confirm exposure +1.25, visibly changed pixels and enabled Undo. Run `--phase edited` after the app settles to preserve the saved XMP and actual rendered inspection.

Click the real app's enabled `editor-undo` button. Capture the restored accessibility tree and canvas, then run `--phase undo`. This phase observes the app; it does **not** send a remote Undo. Verify exposure zero, disabled Undo, restored initial revision and inspection pixels/metrics, persisted XMP exposure zero, and unchanged original bytes. Preserve screenshots, transport replies, XMP copies, hashes, build/test logs and signing provenance. Quit only the owned app after collecting proof.

If computer-use or XCUITest reports an OS authorization denial, retain that failure and report the missing GUI acceptance. Do not bypass it with another automation mechanism. Package service/stdIO tests alone do not prove the live GUI workflow.

The automated companion is `swift test --package-path src/apple/Packages/MapleCore --configuration release -Xswiftc -enable-testing --filter AgentEditServiceTests`. Its additional method is in the existing required test class; no inventory exclusion or timing-based skip is introduced.

For the complete feature workflow, use the same actual stdio bridge to call `maple_list_photos` and `maple_get_thumbnails` for the owned asset, temporarily set a rating and flag, inspect their visible photo-info badges and real XMP, and restore the original culling values. Call `maple_open_photo`, then create a bounded radial mask with the current revision. Capture the visible selected mask, actual overlay and shared vectorscope (including an ROI); use real GUI Undo to remove it, then verify the initial model revision, XMP and original hash. Preserve any inconsistent response fields as findings instead of discarding them.
