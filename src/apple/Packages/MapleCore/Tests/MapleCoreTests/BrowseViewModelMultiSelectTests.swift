// BrowseViewModelMultiSelectTests.swift
// Unit tests for M1 multi-select additions to BrowseViewModel.
//
// Tests the Set logic, mode transitions, and the ≥2 gate — all testable
// without UI automation.
//
// Ticket: #1236 / Part of #1234

import Testing
@testable import MapleCore

// MARK: - BrowseViewModelMultiSelectTests

@MainActor
struct BrowseViewModelMultiSelectTests {

    // MARK: - Helpers

    private func makeVM(assetCount: Int = 5) -> BrowseViewModel {
        let vm = BrowseViewModel()
        vm.assets = (0..<assetCount).map { i in
            AssetRef.preview(displayName: "IMG_\(i).dng")
        }
        return vm
    }

    // MARK: - Mode transitions

    @Test("starts outside select mode")
    func startsIdle() {
        let vm = makeVM()
        #expect(!vm.isSelecting)
        #expect(vm.selectedIDs.isEmpty)
    }

    @Test("enterSelectMode flips isSelecting")
    func enterSelectMode() {
        let vm = makeVM()
        vm.enterSelectMode()
        #expect(vm.isSelecting)
    }

    @Test("exitSelectMode clears isSelecting and selectedIDs")
    func exitSelectMode() {
        let vm = makeVM()
        vm.enterSelectMode()
        let id = vm.assets[0].id
        vm.select(id)
        vm.exitSelectMode()
        #expect(!vm.isSelecting)
        #expect(vm.selectedIDs.isEmpty)
    }

    @Test("exitSelectMode does not disturb single selectedID")
    func exitSelectModeKeepsSingleSelection() {
        let vm = makeVM()
        let id = vm.assets[0].id
        vm.selectedID = id
        vm.enterSelectMode()
        vm.select(vm.assets[1].id)
        vm.exitSelectMode()
        #expect(vm.selectedID == id, "single selectedID should survive select-mode exit")
    }

    // MARK: - Set operations

    @Test("select adds to selectedIDs when in select mode")
    func selectAdds() {
        let vm = makeVM()
        vm.enterSelectMode()
        let id = vm.assets[0].id
        vm.select(id)
        #expect(vm.selectedIDs.contains(id))
    }

    @Test("select is no-op outside select mode")
    func selectIgnoredOutsideMode() {
        let vm = makeVM()
        vm.select(vm.assets[0].id)
        #expect(vm.selectedIDs.isEmpty)
    }

    @Test("deselect removes from selectedIDs when in select mode")
    func deselectRemoves() {
        let vm = makeVM()
        vm.enterSelectMode()
        let id = vm.assets[0].id
        vm.select(id)
        vm.deselect(id)
        #expect(!vm.selectedIDs.contains(id))
    }

    @Test("toggleSelected toggles checked state")
    func toggle() {
        let vm = makeVM()
        vm.enterSelectMode()
        let id = vm.assets[0].id
        vm.toggleSelected(id)
        #expect(vm.selectedIDs.contains(id))
        vm.toggleSelected(id)
        #expect(!vm.selectedIDs.contains(id))
    }

    @Test("toggleSelected is no-op outside select mode")
    func toggleIgnoredOutsideMode() {
        let vm = makeVM()
        vm.toggleSelected(vm.assets[0].id)
        #expect(vm.selectedIDs.isEmpty)
    }

    @Test("clearSelection empties selectedIDs while staying in select mode")
    func clearSelectionStaysInMode() {
        let vm = makeVM()
        vm.enterSelectMode()
        vm.select(vm.assets[0].id)
        vm.select(vm.assets[1].id)
        vm.clearSelection()
        #expect(vm.selectedIDs.isEmpty)
        #expect(vm.isSelecting, "should still be in select mode after clearSelection")
    }

    // MARK: - canMergePanorama gate

    @Test("canMergePanorama is false with 0 selected")
    func mergeGate0() {
        let vm = makeVM()
        vm.enterSelectMode()
        #expect(!vm.canMergePanorama)
    }

    @Test("canMergePanorama is false with 1 selected")
    func mergeGate1() {
        let vm = makeVM()
        vm.enterSelectMode()
        vm.select(vm.assets[0].id)
        #expect(!vm.canMergePanorama)
    }

    @Test("canMergePanorama is true with exactly 2 selected")
    func mergeGate2() {
        let vm = makeVM()
        vm.enterSelectMode()
        vm.select(vm.assets[0].id)
        vm.select(vm.assets[1].id)
        #expect(vm.canMergePanorama)
    }

    @Test("canMergePanorama is true with 5 selected")
    func mergeGate5() {
        let vm = makeVM()
        vm.enterSelectMode()
        vm.assets.forEach { vm.select($0.id) }
        #expect(vm.canMergePanorama)
        #expect(vm.selectedIDs.count == 5)
    }

    // MARK: - selectedAssets ordering

    @Test("selectedAssets preserves assets order")
    func selectedAssetsOrder() {
        let vm = makeVM(assetCount: 4)
        vm.enterSelectMode()
        // Select in reverse order — result should still follow `assets` order.
        vm.select(vm.assets[3].id)
        vm.select(vm.assets[1].id)
        let selected = vm.selectedAssets
        #expect(selected.count == 2)
        #expect(selected[0].id == vm.assets[1].id)
        #expect(selected[1].id == vm.assets[3].id)
    }

    // MARK: - clear()

    @Test("clear() exits select mode and wipes selectedIDs")
    func clearResetsSelectState() {
        let vm = makeVM()
        vm.enterSelectMode()
        vm.select(vm.assets[0].id)
        vm.clear()
        #expect(!vm.isSelecting)
        #expect(vm.selectedIDs.isEmpty)
    }
}
