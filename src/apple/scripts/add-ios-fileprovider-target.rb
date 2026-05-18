#!/usr/bin/env ruby
# src/apple/scripts/add-ios-fileprovider-target.rb
#
# One-shot edit: add the MapleFileProviderIOS app-extension target to
# Maple.xcodeproj. Mirrors the macOS MapleFileProvider target's settings
# but with iOS SDK, iOS 17 deployment, no app-sandbox entitlement.
#
# Usage:
#   cd src/apple && ruby scripts/add-ios-fileprovider-target.rb
#
# Idempotent: re-running once the target exists is a no-op.

require "xcodeproj"

PROJECT_PATH = File.expand_path("../Maple.xcodeproj", __dir__)
TARGET_NAME  = "MapleFileProviderIOS"
PRODUCT_BUNDLE_ID = "app.justmaple.aperture.FileProviderIOS"
DEPLOYMENT_TARGET = "17.0"
TEAM = "QREP66JW5U"

project = Xcodeproj::Project.open(PROJECT_PATH)

if project.targets.any? { |t| t.name == TARGET_NAME }
  warn "[add-ios-fileprovider-target] target already exists — nothing to do."
  exit 0
end

app_target = project.targets.find { |t| t.name == "Maple" } \
  or abort "[add-ios-fileprovider-target] Maple app target not found"

core_pkg = project.root_object.package_references.find { |r|
  r.respond_to?(:relative_path) && r.relative_path == "Packages/MapleCore"
} or abort "[add-ios-fileprovider-target] MapleCore SPM reference not found"

# --- Group + file references ---------------------------------------------
group = project.main_group.new_group(TARGET_NAME, TARGET_NAME)
swift_ref   = group.new_reference("FileProviderExtensionIOS.swift")
info_ref    = group.new_reference("Info.plist")
entitle_ref = group.new_reference("MapleFileProviderIOS.entitlements")

# --- Target ---------------------------------------------------------------
target = project.new_target(:app_extension, TARGET_NAME, :ios, DEPLOYMENT_TARGET)
target.product_name = TARGET_NAME

# Wire MapleCore SPM product into this target's frameworks build phase.
# Mirrors the canonical structure used by the macOS MapleFileProvider
# target — see PBXBuildFile entry at the top of project.pbxproj:
#   { isa = PBXBuildFile; productRef = <pkg-product-id> }
core_dep = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
core_dep.package = core_pkg
core_dep.product_name = "MapleCore"
target.package_product_dependencies << core_dep
build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
build_file.product_ref = core_dep
target.frameworks_build_phase.files << build_file

# Add FileProvider.framework (system framework already referenced elsewhere
# in the project; find the existing reference if present).
fp_ref = project.frameworks_group.files.find { |f|
  f.path&.include?("FileProvider.framework")
}
fp_ref ||= project.frameworks_group.new_file(
  "System/Library/Frameworks/FileProvider.framework",
  :sdk_root,
)
target.frameworks_build_phase.add_file_reference(fp_ref)

# Sources.
target.source_build_phase.add_file_reference(swift_ref)

# Build settings — match the macOS extension, swap SDK to iOS.
%w[Debug Release].each do |cfg_name|
  bc = target.build_configuration_list.build_configurations.find { |b| b.name == cfg_name }
  bc.build_settings.merge!(
    "PRODUCT_BUNDLE_IDENTIFIER"   => PRODUCT_BUNDLE_ID,
    "PRODUCT_NAME"                => TARGET_NAME,
    "INFOPLIST_FILE"              => "#{TARGET_NAME}/Info.plist",
    "GENERATE_INFOPLIST_FILE"     => "NO",
    "CURRENT_PROJECT_VERSION"     => "1",
    "MARKETING_VERSION"           => "0.1.0",
    "CODE_SIGN_ENTITLEMENTS"      => "#{TARGET_NAME}/MapleFileProviderIOS.entitlements",
    "CODE_SIGN_STYLE"             => "Automatic",
    "DEVELOPMENT_TEAM"            => TEAM,
    "IPHONEOS_DEPLOYMENT_TARGET"  => DEPLOYMENT_TARGET,
    "SDKROOT"                     => "iphoneos",
    "SUPPORTED_PLATFORMS"         => "iphoneos iphonesimulator",
    "TARGETED_DEVICE_FAMILY"      => "1,2",
    "SWIFT_VERSION"               => "5.10",
    "SKIP_INSTALL"                => "YES",
    "ENABLE_HARDENED_RUNTIME"     => "NO",
    "LD_RUNPATH_SEARCH_PATHS"     => [
      "$(inherited)", "@executable_path/Frameworks",
      "@executable_path/../../Frameworks",
    ],
  )
end

# --- Embed into the Maple app target -------------------------------------
embed_phase = app_target.copy_files_build_phases.find { |p|
  p.name == "Embed Foundation Extensions"
}
if embed_phase.nil?
  embed_phase = app_target.new_copy_files_build_phase("Embed Foundation Extensions")
  embed_phase.symbol_dst_subfolder_spec = :plug_ins
end
appex_ref = target.product_reference
build_file = embed_phase.add_file_reference(appex_ref)
build_file.settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }
build_file.platform_filters = ["ios"]

# Apply matching platform filter to the macOS sibling so it's excluded
# when building for iOS. (Pre-Phase-4 it was the only extension in this
# embed phase; iOS builds failed only because the macOS appex isn't
# producible for the iOS SDK.)
embed_phase.files.each do |bf|
  if bf.file_ref&.path == "MapleFileProvider.appex"
    bf.platform_filters = ["macos"]
  end
end

app_target.add_dependency(target)

# Platform-filter the dependency itself, not just the embed phase entry —
# Xcode validates entitlements/signing for every active dependency on every
# build, so without this filter the macOS build trips on the iOS extension's
# missing iOS provisioning, and vice versa.
app_target.dependencies.each do |dep|
  case dep.name
  when "MapleFileProvider"     then dep.platform_filters = ["macos"]
  when "MapleFileProviderIOS"  then dep.platform_filters = ["ios"]
  end
end

# Drop the SDK-pinned Foundation.framework reference that
# Xcodeproj.new_target auto-adds for iOS targets. Swift gets Foundation
# implicitly via the stdlib; the explicit reference would pin every
# clone to a specific Xcode SDK version (see PR #66 Issue #4).
foundation_pin = "Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS18.0.sdk/System/Library/Frameworks/Foundation.framework"
target.frameworks_build_phase.files.dup.each do |bf|
  ref = bf.file_ref
  if ref && ref.path == foundation_pin
    target.frameworks_build_phase.remove_build_file(bf)
  end
end
project.files.dup.each do |f|
  if f.path == foundation_pin
    f.remove_from_project
  end
end

project.save
puts "[add-ios-fileprovider-target] target #{TARGET_NAME} added."
