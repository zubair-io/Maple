import Testing
@testable import MapleCore

@MainActor
struct BrowseViewModelRangeSelectionTests {
  private func makeVM(assetCount: Int = 5) -> BrowseViewModel {
    let vm = BrowseViewModel()
    vm.assets = (0..<assetCount).map { AssetRef.preview(displayName: "IMG_\($0).dng") }
    vm.enterSelectMode()
    return vm
  }

  @Test("Shift range follows visible order in both directions")
  func forwardAndReverse() {
    let vm = makeVM()
    let anchor = vm.assets[1].id
    vm.select(anchor)

    vm.selectRange(from: anchor, to: vm.assets[4].id)
    #expect(vm.selectedIDs == Set(vm.assets[1...4].map(\.id)))

    vm.selectRange(from: anchor, to: vm.assets[0].id)
    #expect(vm.selectedIDs == Set(vm.assets[0...1].map(\.id)))
  }

  @Test("A cleared anchor cannot select an old range")
  func clearedAnchor() {
    let vm = makeVM()
    let anchor = vm.assets[0].id
    vm.select(anchor)
    vm.exitSelectMode()
    vm.enterSelectMode()

    vm.selectRange(from: anchor, to: vm.assets[4].id)
    #expect(vm.selectedIDs == Set([vm.assets[4].id]))
  }

  @Test("A folder switch invalidates the old range anchor")
  func staleAnchor() {
    let vm = makeVM()
    let anchor = vm.assets[0].id
    vm.select(anchor)
    vm.assets = (0..<3).map { AssetRef.preview(displayName: "other_\($0).dng") }

    vm.selectRange(from: anchor, to: vm.assets[2].id)
    #expect(vm.selectedIDs == Set([vm.assets[2].id]))
  }
}
