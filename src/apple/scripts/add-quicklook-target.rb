#!/usr/bin/env ruby
# Adds the MapleQuickLook app-extension target to Maple.xcodeproj.
#
# Idempotent — safe to re-run (returns early if the target already exists).
# Mirrors MapleFileProvider's build-setting shape so embedding/sandbox/
# entitlements behaviour is consistent across the two appex targets.

require 'xcodeproj'

PROJECT_PATH = File.expand_path('../Maple.xcodeproj', __dir__)
TARGET_NAME  = 'MapleQuickLook'
BUNDLE_ID    = 'app.justmaple.aperture.QuickLook'
SOURCES_DIR  = File.expand_path('../MapleQuickLook', __dir__)

project = Xcodeproj::Project.open(PROJECT_PATH)

if project.targets.find { |t| t.name == TARGET_NAME }
  puts "[add-quicklook-target] target #{TARGET_NAME} already present — nothing to do"
  exit 0
end

# 1. Source-group on disk.
group = project.main_group.find_subpath(TARGET_NAME, true)
group.set_source_tree('<group>')
group.set_path(TARGET_NAME)

provider_ref     = group.new_reference('MaplePreviewProvider.swift')
info_plist_ref   = group.new_reference('Info.plist')
entitlements_ref = group.new_reference('MapleQuickLook.entitlements')

# 2. The native target itself (app-extension).
target = project.new_target(
  :app_extension,
  TARGET_NAME,
  :osx,
  '14.0',
  project.products_group,
  :swift,
)

# 3. Sources phase.
target.add_file_references([provider_ref])

# 4. Frameworks phase: link QuickLook + QuickLookUI + the shared MapleCore product.
quicklook    = project.frameworks_group.new_reference('System/Library/Frameworks/QuickLook.framework')
quicklook.source_tree = 'SDKROOT'
quicklookui  = project.frameworks_group.new_reference('System/Library/Frameworks/QuickLookUI.framework')
quicklookui.source_tree = 'SDKROOT'
target.frameworks_build_phase.add_file_reference(quicklook)
target.frameworks_build_phase.add_file_reference(quicklookui)

maple_core_ref = project.root_object.package_references.find do |pkg|
  pkg.respond_to?(:relative_path) && pkg.relative_path.to_s.include?('MapleCore')
end
unless maple_core_ref
  abort "[add-quicklook-target] couldn't locate MapleCore package reference"
end
maple_core_dep = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
maple_core_dep.package = maple_core_ref
maple_core_dep.product_name = 'MapleCore'
target.package_product_dependencies << maple_core_dep
maple_core_build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
maple_core_build_file.product_ref = maple_core_dep
target.frameworks_build_phase.files << maple_core_build_file

# 5. Build settings — match MapleFileProvider for parity.
target.build_configurations.each do |cfg|
  cfg.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER'      => BUNDLE_ID,
    'PRODUCT_NAME'                   => TARGET_NAME,
    'MACOSX_DEPLOYMENT_TARGET'       => '14.0',
    'CODE_SIGN_ENTITLEMENTS'         => "#{TARGET_NAME}/MapleQuickLook.entitlements",
    'INFOPLIST_FILE'                 => "#{TARGET_NAME}/Info.plist",
    'GENERATE_INFOPLIST_FILE'        => 'NO',
    'SWIFT_VERSION'                  => '5.0',
    'SKIP_INSTALL'                   => 'YES',
    'DEVELOPMENT_TEAM'               => 'QREP66JW5U',
    'SDKROOT'                        => 'macosx',
    'SUPPORTED_PLATFORMS'            => 'macosx',
    'CODE_SIGN_STYLE'                => 'Automatic',
    'CURRENT_PROJECT_VERSION'        => '1',
    'MARKETING_VERSION'              => '0.1.0',
    'ENABLE_HARDENED_RUNTIME'        => 'YES',
    'LD_RUNPATH_SEARCH_PATHS'        => [
      '$(inherited)',
      '@executable_path/../../../../Frameworks',
      '@executable_path/../../Frameworks',
    ],
  )
end

# 6. Embed the .appex into the host Maple app, mirroring MapleFileProvider.
maple_target = project.targets.find { |t| t.name == 'Maple' }
abort "[add-quicklook-target] host Maple target missing" unless maple_target

embed_phase = maple_target.copy_files_build_phases.find do |p|
  p.name == 'Embed Foundation Extensions' || p.dst_subfolder_spec == '13'
end
unless embed_phase
  embed_phase = maple_target.new_copy_files_build_phase('Embed Foundation Extensions')
  embed_phase.symbol_dst_subfolder_spec = :plug_ins
end

appex_ref = target.product_reference
build_file = embed_phase.add_file_reference(appex_ref)
build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

# Add as a build dependency so it's compiled before the host links/embeds.
maple_target.add_dependency(target)

project.save
puts "[add-quicklook-target] added #{TARGET_NAME} target and embedded into Maple"
