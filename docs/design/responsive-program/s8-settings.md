# Responsive Program — S8: Settings Tab Content

Eighth and final sub-project of the responsive program (epic [#577](https://github.com/zubair-io/Maple/issues/577)). Replaces the S1a interim Settings tab content (`SettingsView()` as-is — a TabView-in-TabView) with a phone-native iOS Settings.app-style List + push pattern.

No mockup exists in `/Users/riabuz/Projects/_Maple/mobile/Maple Mobile Editor.html` for Settings — this spec proposes an iOS-Settings-style starting point. Reviewer can push back during PR design review.

One ticket — **S8** — shipped as one PR.

---

## 1. Overview & deliverable map

| Ticket | What ships | Files touched | Blocks |
|---|---|---|---|
| **S8** | `PhoneSettingsView` — replaces S1a's `SettingsView()` placeholder in the Settings tab. iOS Settings.app-style: grouped List with rows (icon + label + chevron + secondary text). Each row pushes to a sub-view in the Settings tab's NavStack. Sub-views are the existing General / Backup / Self Hosted / Files tabs from desktop `SettingsView`, each rendered as a stand-alone screen. Web equivalent. Tablet/desktop Settings unchanged (still modal `SettingsView()` from existing Mac path). | Edit `src/apple/Maple/Views/PhoneTabShell.swift` (Settings tab uses new `PhoneSettingsView`), new `src/apple/Maple/Views/PhoneSettingsView.swift`, new sub-view glue files (extract from existing `SettingsView` into stand-alone Views), new `src/web/projects/maple-common/src/lib/settings/phone-settings.component.{ts,html,scss,spec.ts}`, sub-view route components, web `settings-page.component.ts` | — |

S8 depends on S1a (Settings tab routing slot).

---

## 2. Visual design (proposed; no mockup)

### Phone Settings tab — root view

Grouped List, each row 56pt tall with leading icon (24pt SF Symbol), label (Lato 14pt `textMain`), optional secondary text (Lato 12pt `textMuted` right-aligned), trailing chevron (`chevron.right`).

Sections (proposed):

**Account**
- Profile (icon: person.circle) — push to account settings
- Maple Cloud (icon: cloud) — sign-in status, server list — push to Self Hosted sub-view
- Sign out (destructive; only if signed-in)

**Library**
- Sources (icon: folder.badge.plus) — push to source management (add folder, add SMB, etc.)
- Backup (icon: icloud.and.arrow.up) — push to Backup sub-view
- Files (icon: folder) — push to FileProvider sub-view (iOS-specific)

**App**
- Appearance (icon: paintpalette) — placeholder for theme switcher (out of scope v0.1; reads-only "Dark")
- Notifications (icon: bell) — push to notifications settings (stub)
- About (icon: info.circle) — version + acknowledgements
- Diagnostics (icon: ladybug) — push to debug menu (only in #if DEBUG builds)

Use `MapleTokens.surfaceAlt` for the row background; 1pt `border` separators between rows; `bg` for the inter-section gaps.

### Tablet / Desktop

`SettingsView()` modal (existing TabView with General / Backup / Self Hosted / Files) — unchanged. Triggered by the existing `showSettings` flag on Mac/iPad. No tab bar exists at these breakpoints.

The phone push-detail screens (e.g., `BackupSettingsView`) are the SAME views as the desktop modal's tab content. Reuse via shared components.

---

## 3. Apple implementation

### Files

- **New** `src/apple/Maple/Views/PhoneSettingsView.swift`:
  ```swift
  struct PhoneSettingsView: View {
      var body: some View {
          List {
              Section("Account") {
                  NavigationLink { AccountSettingsView() } label: {
                      SettingsRow(icon: "person.circle", label: "Profile")
                  }
                  NavigationLink { SelfHostedSettingsTab() } label: {
                      SettingsRow(icon: "cloud", label: "Maple Cloud")
                  }
              }
              Section("Library") {
                  NavigationLink { /* SourcesManagement */ } label: {
                      SettingsRow(icon: "folder.badge.plus", label: "Sources")
                  }
                  NavigationLink { BackupSettingsView() } label: {
                      SettingsRow(icon: "icloud.and.arrow.up", label: "Backup")
                  }
                  NavigationLink { FileProviderSettingsViewIOS() } label: {
                      SettingsRow(icon: "folder", label: "Files")
                  }
              }
              Section("App") {
                  NavigationLink { /* AboutView */ } label: {
                      SettingsRow(icon: "info.circle", label: "About")
                  }
                  #if DEBUG
                  NavigationLink { DiagnosticsView() } label: {
                      SettingsRow(icon: "ladybug", label: "Diagnostics")
                  }
                  #endif
              }
          }
          .listStyle(.insetGrouped)
      }
  }

  struct SettingsRow: View {
      let icon: String
      let label: String
      var body: some View {
          HStack(spacing: 12) {
              Image(systemName: icon)
                  .foregroundStyle(MapleTokens.primary)
                  .frame(width: 24)
              Text(label).font(MapleTokens.Typography.rowLabel)
          }
      }
  }
  ```
- **Edit** `src/apple/Maple/Views/PhoneTabShell.swift` — Settings tab renders `PhoneSettingsView()` instead of `SettingsView()`:
  ```swift
  NavigationStack { PhoneSettingsView() }
      .tabItem { Label("Settings", systemImage: "gearshape") }
      .tag("settings")
  ```
- **Existing sub-views reused**: `AccountSettingsView`, `BackupSettingsView`, `SelfHostedSettingsTab`, `FileProviderSettingsViewIOS` — make them stand-alone (already are, mostly). Audit at PR time.
- **New stubs**: `SourcesManagementView` (full source-add UI; defer to a follow-up if too much), `AboutView` (version + acknowledgements), `DiagnosticsView` (#if DEBUG; log dump, cache stats).

### Tablet/Desktop unchanged

Pane shell continues to invoke `SettingsView()` as a modal via `showSettings`. No code change.

---

## 4. Web implementation

### `phone-settings.component.ts` (new)

Standalone Angular component, signals, separate templates per CLAUDE.md.

Renders a grouped list using `<section>` + `<a routerLink>` rows. Each row's routerLink pushes to a child route — e.g., `/settings/backup`, `/settings/cloud`, `/settings/about`. Routes defined in app.routes.ts.

```html
<section class="settings-group">
  <h3>Account</h3>
  <a routerLink="/settings/profile" class="settings-row">
    <maple-icon name="person-circle" />
    <span class="label">Profile</span>
    <maple-icon name="chevron-right" class="chevron" />
  </a>
  <a routerLink="/settings/cloud" class="settings-row">
    <maple-icon name="cloud" />
    <span class="label">Maple Cloud</span>
  </a>
</section>
```

Tab-bar visibility stays visible during settings sub-view pushes (Settings sub-views are NOT full-screen immersive like Loupe/Editor — keep tab bar accessible so users can return to Library/Search easily).

### Sub-view route components

- `settings-profile-page.component.ts` (new) — wraps existing profile settings
- `settings-backup-page.component.ts` (new) — backup settings page
- `settings-cloud-page.component.ts` (new) — Maple Cloud settings page
- `settings-about-page.component.ts` (new) — about page
- (others as needed; reuse existing settings components)

Existing `src/web/projects/maple/src/app/settings/` already has `account`, `people`, `users`, `workers` sub-projects + `settings-shell.component`. Most route components can wrap the existing pieces.

### Tablet/Desktop unchanged

Web pane shell's Settings access (already modal? settings-shell?) unchanged. Phone is the only new surface.

---

## 5. Testing strategy

### Apple

- `XCTest` (limited; SwiftUI List structure is hard to assert):
  - `PhoneSettingsViewSectionsTests` — instantiates view, asserts navigation destinations exist (smoke).
- `#Preview` for `PhoneSettingsView` showing all rows + sections.

### Web

- `phone-settings.component.spec.ts` — renders correct sections + rows; each row has correct routerLink.
- Sub-view route component tests — each wraps the existing settings component and renders it.
- Playwright e2e — tap Settings tab → tap Backup row → verify route is `/settings/backup` → tap back chevron → returns to Settings root.

### CI gates

Same as S0/S1 baseline.

---

## 6. Risks & open questions

### Risks

1. **No mockup exists** — this spec is proposed-not-prescribed. Designer may want a different layout (e.g., simpler flat list, or sub-page-as-modal-not-push, or fewer/different sections). Treat as a starting point.
2. **Existing `SettingsView` as Mac/iPad modal** has 4 tabs (General / Backup / Self Hosted / Files); S8's iOS-style List has more rows. Mapping isn't 1:1 — "General" tab content (version display) becomes the About row. Some content moves around.
3. **`FileProviderSettingsViewIOS`** is iOS-specific. The Files row on the phone Settings list only appears on iOS. Wrap in `#if os(iOS)`.
4. **`#DEBUG`-only Diagnostics row** — visible in dev builds, hidden in App Store builds. Standard pattern.
5. **"Sources" row** — managing sources (add folder, add SMB, etc.) is a non-trivial UX. May warrant its own sub-spec. For S8, just push to a placeholder; file a follow-up for full Sources Management UX.

### Open questions

1. **Section labels** — "Account / Library / App" feels iOS-canonical but Maple-specific groupings might be better. Reviewer eyeball.
2. **Sign Out as a row vs a button at the bottom** — iOS Settings.app uses Apple ID at the top with sign-out inside. Maple has no equivalent — could just be a row at the bottom of "Account".
3. **Maple Cloud sign-in flow on phone** — currently a modal sheet (`AddMapleCloudSheet`); should it remain a modal or become a pushed flow? Probably stay modal (auth flow is inherently focus-stealing).
4. **Backup status visibility** — show "Backup: in progress (42%)" as the row's secondary text? Useful but requires plumbing to the backup engine's progress signal. Defer to a follow-up.
5. **About content** — version + build hash + acknowledgements + license attributions (Lato, Merriweather, etc. OFL notices). Required for App Store? Probably yes — file a follow-up if Apple submission gates on this.
