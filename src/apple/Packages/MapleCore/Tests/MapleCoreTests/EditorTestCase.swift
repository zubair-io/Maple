// EditorTestCase.swift — base class for tests that build an `EditorState`.
//
// `EditorState.init` defaults its `subParamMemory` to
// `ToolSubParamMemory.shared`, which is app-session state: the last
// sub-param armed per tool, deliberately outliving an image switch so the
// selection survives rebuilding `EditorState` for the next asset (#1108).
// That singleton is process-global, so inside one test-target run it also
// outlives the *test* that armed it. A test arming Noise · Deep left Deep
// armed for every later test that built an `EditorState` on the default
// store, and the next `setArmedDisplayValue` landed on `deepDenoise`
// instead of `nrLuminance` — a failure that only appears in a full-suite
// run and vanishes under `--filter`, because the leak needs the earlier
// test to have run first.
//
// Clearing the store before each test makes those tests order-independent.
// `EditorSubParamTests` predates this and injects its own fresh instance
// per state instead — either isolates; what must not happen is inheriting
// `.shared` untouched.

import XCTest

@testable import MapleCore

@MainActor
class EditorTestCase: XCTestCase {
    override func setUp() {
        super.setUp()
        ToolSubParamMemory.shared.reset()
    }
}
