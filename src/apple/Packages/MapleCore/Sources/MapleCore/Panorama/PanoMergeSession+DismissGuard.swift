// PanoMergeSession+DismissGuard.swift — when closing the panorama merge view
// would throw work away, so the view asks first (#5662).

extension PanoMergeSession {
    /// A stitch is running, or its finished panorama has not been added to
    /// the library yet. Idle, preview-only and failed states lose nothing.
    public var closingDiscardsWork: Bool {
        switch state {
        case .running, .finishingAlignment, .done: return true
        case .idle, .error: return false
        }
    }
}
