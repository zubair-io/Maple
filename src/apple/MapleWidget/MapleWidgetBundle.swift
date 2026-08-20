// MapleWidgetBundle.swift
//
// Extension entry point. One widget today; the bundle exists so adding a
// second (a Light Table shuffle, an on-this-day tile) is a one-line change.

import SwiftUI
import WidgetKit

@main
struct MapleWidgetBundle: WidgetBundle {
  var body: some Widget {
    GeneratedSearchWidget()
  }
}
