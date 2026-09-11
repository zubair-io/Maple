// BrowseViewModelPhotosAuthTests.swift
// The Photos-permission grid state must wipe the prior source's grid
// wholesale. `BrowseGrid` mounts the permission panel only when both
// `assets` and `subfolders` are empty, so a leftover sub-folder list from
// the previous cloud/local folder hid the Connect button — the only in-app
// route to requesting Photos access (#3386).

import Foundation
import Testing
@testable import MapleCore

@MainActor
struct BrowseViewModelPhotosAuthTests {

    @Test("setPhotosAuthNeeded clears sub-folders left by the previous source")
    func clearsSubfolders() {
        let vm = BrowseViewModel()
        vm.assets = [AssetRef.preview(displayName: "IMG_0001.dng")]
        vm.subfolders = [
            URL(fileURLWithPath: "/cloud/2024", isDirectory: true),
            URL(fileURLWithPath: "/cloud/2025", isDirectory: true),
        ]

        vm.setPhotosAuthNeeded(canRequest: true)

        #expect(vm.assets.isEmpty)
        #expect(vm.subfolders.isEmpty)
        #expect(vm.photosAuthNeeded)
        #expect(vm.photosAuthCanRequest)
        #expect(vm.currentSource == nil)
        #expect(!vm.isLoading)
    }

    @Test("loadFolder(url:) on an empty folder clears a leftover Photos-permission state (#3536)")
    func loadFolderClearsPhotosAuth() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-photos-auth-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let vm = BrowseViewModel()
        vm.setPhotosAuthNeeded(canRequest: true)

        vm.loadFolder(url: dir)

        #expect(vm.assets.isEmpty)
        #expect(vm.subfolders.isEmpty)
        #expect(!vm.photosAuthNeeded)
        #expect(vm.loadError == nil)
    }
}
