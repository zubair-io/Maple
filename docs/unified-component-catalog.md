# Unified Component Catalog

The design inventory. Every element appears once, grouped by **what it is**, not which product it came from. Each tier lists what it's built from, so you can design in dependency order.

Names here are design names. Implementation prefixes (`ui-`, platform types) are a code concern and don't appear.

---

## How to use this

- **Atoms** — design these first. Nothing depends on anything else. The work is variants, sizes, and states.
- **Molecules** — built only from atoms (Level 1) or from atoms plus earlier molecules (Level 2). The work is composition, spacing, and internal states.
- **Organisms** — built from molecules. The work is layout, data states (loading/empty/error), and responsive behavior.
- **Templates** — regions only, no content. The work is breakpoints and region sizing.
- **Pages** — a template plus organisms. The work is which organisms go where.

The **Built from** column is the dependency. Don't design something until everything in its Built-from column is done. §7 gives the resulting order.

---

## 1. Atoms

### 1.1 Actions

| Element           | Purpose                              | To design                                                                                                                                                                                 |
| ----------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Button**        | Text action, optional icon           | Variants: primary, secondary, outline, ghost, destructive · Sizes: sm, md, lg · States: default, hover, active, focus, disabled, loading · Icon slots: leading, trailing, both, icon-only |
| **Action Button** | Compact icon+label pill for toolbars | Sizes: sm, md · States: default, hover, active, focus, disabled, selected · Orientation: horizontal, stacked                                                                              |
| **Icon**          | Single glyph                         | Sizes: xs, sm, md, lg, xl · Stroke vs. filled · Optical alignment rules                                                                                                                   |
| **Link**          | Inline hyperlink                     | States: default, hover, visited, focus · Internal vs. external (affordance for external)                                                                                                  |

### 1.2 Content

| Element       | Purpose                   | To design                                                                                                 |
| ------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Text**      | Styled text block         | The full type scale · Weights · Color roles: main, muted, on-accent, semantic · Truncation and line-clamp |
| **Timestamp** | Formatted date/time       | Formats: relative, short, long, time-only · Tooltip on hover                                              |
| **Badge**     | Small status label        | Variants: neutral, accent, success, warning, error · With/without leading dot or icon · Sizes: sm, md     |
| **Stat**      | Labeled numeric value     | Sizes: sm, lg · Optional delta indicator and trend direction                                              |
| **Divider**   | Rule, optional label      | Orientation: horizontal, vertical · With/without centered label · Inset vs. full-bleed                    |
| **List**      | Ordered / unordered items | Marker styles · Nesting indent · Spacing density                                                          |

### 1.3 Form controls

| Element              | Purpose                | To design                                                                                                                                             |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Input**            | Single-line text field | Sizes: sm, md · States: default, focus, filled, error, disabled, read-only · Slots: prefix icon, suffix action, clear · Numeric variant with steppers |
| **Checkbox**         | Labeled boolean        | States: unchecked, checked, indeterminate, focus, disabled · Label position                                                                           |
| **Segmented Toggle** | 2–3 exclusive options  | Segment counts: 2, 3 · States per segment · Selection indicator motion                                                                                |

### 1.4 Media

| Element            | Purpose                            | To design                                                                      |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------ |
| **Image**          | Raster leaf                        | Fit modes: fill, fit · Radii · Placeholder and broken states · Aspect handling |
| **Remote Image**   | Authenticated, cached, tiered load | Tiers: thumb → preview → full · Blur-up transition · Retry affordance          |
| **Avatar**         | User image with initials fallback  | Sizes: xs, sm, md, lg · Fallback color derivation · Presence dot               |
| **QR Code**        | Renders a payload as a QR image    | Sizes · Quiet zone · Contrast requirement                                      |
| **Canvas Surface** | Hosts a GPU-rendered layer         | Letterbox behavior · Background · Loading state before first frame             |

### 1.5 Feedback

| Element         | Purpose                       | To design                                                                                               |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Progress**    | Determinate or indeterminate  | Shapes: bar, ring · Sizes · Indeterminate animation · With/without label                                |
| **Spinner**     | Small indeterminate indicator | Sizes: sm, md · Inline vs. centered · Delay-before-show threshold                                       |
| **Status Text** | Persistence / sync state line | States: idle, saving, saved, offline, error · Icon pairing                                              |
| **Toast**       | Transient notification        | Variants: info, success, warning, error · With/without action · Auto-dismiss timing · Enter/exit motion |

**22 atoms.**

---

## 2. Molecules — Level 1

Built only from atoms.

### 2.1 Form & entry

| Element                 | Purpose                             | Built from                |
| ----------------------- | ----------------------------------- | ------------------------- |
| **Form Field**          | Label + control + help/error        | Text, Input, Text         |
| **Inline Rename Field** | Edit-in-place name                  | Input, Text               |
| **Search Bar**          | Query pill with clear               | Icon, Input, Button       |
| **Slider**              | Labeled slider with numeric readout | Text, Input               |
| **Living Slider**       | Gradient-track slider               | Text, Input               |
| **Drag Bar**            | Tick-marked scrub control           | Text                      |
| **Color Wheel**         | Draggable hue/saturation puck       | _(none — primitive plot)_ |
| **2-D Pad**             | Two-axis draggable puck             | _(none — primitive plot)_ |

### 2.2 Selection

| Element            | Purpose                               | Built from                    |
| ------------------ | ------------------------------------- | ----------------------------- |
| **Chip Row**       | Row of pills — select, apply, or edit | Badge, Icon, Input            |
| **Tabs**           | Tab row with selection indicator      | Text, Icon                    |
| **Tree Row**       | One row of a hierarchical tree        | Icon, Text, Badge, Spinner    |
| **List Row**       | Row with metadata and inline actions  | Icon, Text, Timestamp, Button |
| **Rating & Flags** | Star rating plus pick/reject          | Icon, Badge                   |

### 2.3 Feedback & messaging

| Element             | Purpose                               | Built from               |
| ------------------- | ------------------------------------- | ------------------------ |
| **Banner**          | Inline status strip                   | Icon, Text, Link, Button |
| **Toast Container** | Stacks and positions toasts           | Toast                    |
| **Empty State**     | Icon, title, message, optional action | Icon, Text, Button       |
| **Value Chip**      | Floating value readout during a drag  | Badge, Text              |
| **Value HUD**       | Center-screen scrub overlay           | Text, Progress           |
| **Frame-time HUD**  | Performance readout overlay           | Text                     |

### 2.4 Overlays & menus

| Element             | Purpose                        | Built from                       |
| ------------------- | ------------------------------ | -------------------------------- |
| **Popover**         | Anchored floating container    | _(none — positioning primitive)_ |
| **Context Menu**    | Keyboard-navigable action list | Popover, Icon, Text, Divider     |
| **Suggestion Menu** | Query-driven autocomplete list | Popover, Icon, Text              |
| **Command Menu**    | Searchable command palette     | Popover, Input, Icon, Text       |

### 2.5 Structure

| Element              | Purpose                            | Built from                   |
| -------------------- | ---------------------------------- | ---------------------------- |
| **Collapsible**      | Disclosure header + content region | Icon, Text                   |
| **Page Header**      | Title bar with back and actions    | Button, Text, Icon           |
| **Toolbar**          | Row of actions with overflow       | Action Button, Divider, Icon |
| **Bubble Menu**      | Floating contextual format bar     | Icon, Divider                |
| **Label-Value Grid** | Two-column metadata grid           | Text                         |
| **Avatar Group**     | Overlapping avatars with overflow  | Avatar, Badge                |

### 2.6 Data plots

| Element              | Purpose                            | Built from         |
| -------------------- | ---------------------------------- | ------------------ |
| **Histogram**        | RGB distribution plot              | _(plot primitive)_ |
| **Waveform**         | Luma waveform                      | _(plot primitive)_ |
| **Parade**           | Three-channel waveform             | _(plot primitive)_ |
| **Vectorscope**      | Chroma scatter plot                | _(plot primitive)_ |
| **Curve Plot**       | Draggable point curve              | _(plot primitive)_ |
| **Connection Graph** | Node-link graph                    | _(plot primitive)_ |
| **Heatmap Layer**    | Density overlay synced to a camera | _(plot primitive)_ |

### 2.7 Media

| Element            | Purpose                          | Built from                  |
| ------------------ | -------------------------------- | --------------------------- |
| **Map Annotation** | Thumbnail pin or count cluster   | Image, Badge, Text          |
| **Preview Image**  | Static image with load lifecycle | Image, Spinner              |
| **Video Player**   | Playback with transport controls | Button, Progress, Timestamp |
| **Audio Player**   | Waveform-less audio transport    | Button, Progress, Timestamp |
| **Drag Preview**   | Ghost shown while dragging       | Image, Badge                |
| **Code Block**     | Monospace block with copy        | Text, Button                |

**44 molecules at Level 1.**

---

## 3. Molecules — Level 2

Built from atoms plus Level 1 molecules.

| Element                | Purpose                                  | Built from                                        |
| ---------------------- | ---------------------------------------- | ------------------------------------------------- |
| **Media Cell**         | Thumbnail with badges, rating, selection | Image, Badge, Rating & Flags, Inline Rename Field |
| **Card**               | Image + title + metadata tile            | Image, Text, Badge                                |
| **Dialog**             | Prompt, confirm, or choice               | Popover, Text, Input, Button                      |
| **Settings Row**       | Collapsible labeled setting              | Collapsible, Icon, Text, Divider                  |
| **Embed Shell**        | Frame for embedded content               | Page Header, Progress, Icon                       |
| **Description Field**  | Text with override and regenerate        | Text, Input, Button                               |
| **Transcript Block**   | Timestamped read-only transcript         | Text, Timestamp                                   |
| **Faces Row**          | Count, person chips, re-detect           | Chip Row, Button, Text                            |
| **Place Row**          | Geocoded place with override             | Text, Input, Button                               |
| **Vision Row**         | Classification result chips              | Chip Row                                          |
| **Keyword Row**        | Editable tag chips                       | Chip Row, Input                                   |
| **Preview List**       | Before → after row list                  | List Row, Text                                    |
| **Progress Step**      | One step of a wizard                     | Text, Progress, Button                            |
| **Suggestion Preview** | Proposed change with accept/reject       | Text, Button                                      |
| **Bot Output**         | Streaming generated result               | Text, Progress, Avatar                            |
| **Endpoint Form**      | Interactive request builder              | Form Field, Button, Badge                         |
| **Response Viewer**    | Formatted response with status           | Code Block, Badge, Tabs                           |
| **Filmstrip Row**      | Horizontal scrolling thumbnails          | Media Cell                                        |
| **Filmstrip Rail**     | Collapsible vertical thumbnails          | Media Cell, Icon                                  |
| **QR Scanner**         | Camera or paste payload capture          | Input, Button, Canvas Surface                     |
| **Chat Message**       | One message bubble                       | Avatar, Text, Timestamp                           |
| **Typing Indicator**   | Someone-is-typing affordance             | Avatar, Text                                      |
| **Todo Popover**       | Task attribute editor                    | Popover, Form Field, Chip Row                     |
| **Event Popover**      | Calendar event create/edit               | Popover, Form Field, Button                       |

**24 molecules at Level 2. 68 molecules total.**

---

## 4. Organisms

### 4.1 Collections

| Element             | Purpose                               | Built from                                     |
| ------------------- | ------------------------------------- | ---------------------------------------------- |
| **Collection Grid** | Virtualized selectable thumbnail grid | Media Cell, Empty State, Spinner, Drag Preview |
| **List View**       | Virtualized row list                  | List Row, Empty State, Spinner                 |
| **Timeline**        | Date-grouped infinite scroll          | Collection Grid, Text, Chip Row                |
| **Kanban Board**    | Drag-and-drop column board            | Card, Text, Button                             |
| **Filmstrip**       | Focus-following thumbnail strip       | Filmstrip Row, Filmstrip Rail                  |
| **Search Results**  | Paginated result grid with states     | Collection Grid, Empty State, Progress         |

### 4.2 Navigation

| Element          | Purpose                              | Built from                                                          |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------- |
| **Sidebar**      | Hierarchical source / page tree      | Tree Row, Toolbar, Collapsible, Context Menu, Empty State           |
| **Tool Dock**    | Tool group switcher                  | Action Button, Divider, Icon                                        |
| **Search**       | Query, filters, and results together | Search Bar, Chip Row, Suggestion Menu, Search Results, Filter Panel |
| **Filter Panel** | Faceted multi-select filters         | Collapsible, Chip Row, Checkbox, Form Field                         |

### 4.3 Inspectors & panels

| Element                   | Purpose                            | Built from                                                                    |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| **Inspector Panel**       | Tabbed right-side detail region    | Tabs, Page Header                                                             |
| **Info Panel**            | Full asset metadata                | Label-Value Grid, Histogram, Keyword Row, Rating & Flags, Inline Rename Field |
| **Enrichment Panel**      | AI-derived fields with live status | Description Field, Faces Row, Place Row, Transcript Block, Vision Row, Badge  |
| **Adjustments Panel**     | All tool-group sliders             | Living Slider, Collapsible, Tabs                                              |
| **Color Grading Panel**   | Shadows / mids / highlights        | Color Wheel, Living Slider                                                    |
| **HSL Panel**             | Per-band hue / sat / luminance     | Chip Row, Living Slider                                                       |
| **Tone Curve Panel**      | Channel curve plus parametrics     | Tabs, Curve Plot, Living Slider                                               |
| **Film Panel**            | Look catalog with strength         | Chip Row, Card, Living Slider                                                 |
| **Presets Panel**         | Save, apply, delete presets        | List Row, Button, Dialog                                                      |
| **Scopes Panel**          | Pinned four-up scope stack         | Histogram, Waveform, Parade, Vectorscope                                      |
| **Backlinks Panel**       | Inbound references                 | List Row, Empty State                                                         |
| **Version History Panel** | Browse and restore versions        | List Row, Timestamp, Button, Dialog                                           |
| **Thread Panel**          | Reply thread                       | Chat Message, Input, Button                                                   |

### 4.4 Modals

All built on the **Overlay Shell** template (§5).

| Element              | Purpose                            | Built from                                   |
| -------------------- | ---------------------------------- | -------------------------------------------- |
| **Export**           | Format, size, quality, color space | Form Field, Progress, Banner                 |
| **Batch Rename**     | Template with live preview         | Form Field, Chip Row, Preview List, Progress |
| **Batch Metadata**   | Multi-field editor with confirm    | Form Field, Dialog, Progress                 |
| **Move To**          | Tree destination picker            | Tree Row, Search Bar, Button                 |
| **Panorama Merge**   | Stitch options and progress        | Form Field, Progress, Media Cell             |
| **Selective Paste**  | Per-group apply toggles            | Checkbox, Text, Button                       |
| **Library Picker**   | Remote filesystem browser          | Tree Row, Toolbar, Empty State               |
| **Add Server**       | Sign-in and registration           | Form Field, Button, Banner                   |
| **Pair Device**      | Multi-step pairing flow            | QR Code, QR Scanner, Progress, Progress Step |
| **Share**            | Manage members and access          | Avatar Group, Form Field, List Row           |
| **Template Gallery** | Browse and apply templates         | Card, Search Bar, Empty State                |
| **Card Detail**      | Expanded board-card editor         | Form Field, Chip Row, Rich Text Editor       |
| **Result Report**    | Per-item batch outcome             | List Row, Badge, Empty State                 |

### 4.5 Editing surfaces

| Element                    | Purpose                           | Built from                                                          |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| **Image Canvas**           | Zoom, pan, before/after, render   | Canvas Surface, Preview Image, Crop Overlay                         |
| **Crop Overlay**           | Draggable crop with grid and mask | Drag Bar, Icon                                                      |
| **Crop Toolbar**           | Aspect presets and straighten     | Chip Row, Drag Bar, Button                                          |
| **Control Surface**        | Panel for the armed tool          | Tabs, Living Slider, Chip Row, Value Chip                           |
| **Mobile Control Bar**     | Phone bottom control stack        | Tool Dock, Control Surface, Tabs                                    |
| **Rich Text Editor**       | Structured document editing       | Bubble Menu, Command Menu, Suggestion Menu, Embed Shell, Code Block |
| **Whiteboard Canvas**      | Freeform canvas with AI prompt    | Canvas Surface, Toolbar, Command Menu                               |
| **Structured Data Editor** | JSON as code or as a form         | Code Block, Form Field, Tabs                                        |
| **Preview Surface**        | Full-screen media preview         | Page Header, Filmstrip, Preview Image, Video Player, Toolbar        |

### 4.6 Map

| Element         | Purpose                             | Built from                                 |
| --------------- | ----------------------------------- | ------------------------------------------ |
| **Map Surface** | Clustered pins with density overlay | Map Annotation, Heatmap Layer, Empty State |

### 4.7 Communication

| Element               | Purpose                  | Built from                                             |
| --------------------- | ------------------------ | ------------------------------------------------------ |
| **Chat**              | Real-time conversation   | Chat Message, Typing Indicator, Input, Suggestion Menu |
| **Notification Feed** | Filterable activity list | List Row, Chip Row, Empty State                        |

### 4.8 Configuration

| Element              | Purpose                          | Built from                                |
| -------------------- | -------------------------------- | ----------------------------------------- |
| **Settings Section** | A group of related settings      | Settings Row, Form Field, Divider, Banner |
| **Pipeline Monitor** | Live stage status and metrics    | List Row, Progress, Badge, Empty State    |
| **Setup Wizard**     | Multi-step guided configuration  | Progress Step, Tabs, Form Field, Button   |
| **User Management**  | Invite, list, and revoke access  | List Row, QR Code, Dialog, Form Field     |
| **Device List**      | Paired devices with revoke       | List Row, Dialog, Empty State             |
| **Backup Monitor**   | Configuration plus live progress | Form Field, Progress, Banner              |
| **Diagnostics**      | Validation runs and raw output   | Button, Code Block, Badge                 |

**52 organisms.**

---

## 5. Templates

Regions only. No content.

| Element            | Regions                        | To design                                                           |
| ------------------ | ------------------------------ | ------------------------------------------------------------------- |
| **App Shell**      | Navigation · Content · Overlay | Root layout, overlay stacking order, toast/banner anchoring         |
| **Split Layout**   | Sidebar · Center · Detail      | Min/max widths, collapse order, resize handles                      |
| **Tab Shell**      | Tab bar · Content              | Tab bar placement per breakpoint, badge positioning                 |
| **Settings Shell** | Section nav · Pane             | Nav width, pane max-width, deep-link behavior                       |
| **Overlay Shell**  | Scrim · Header · Body · Footer | Sizes: sm, md, lg, full · Focus trap, dismissal, scroll containment |
| **Sheet Shell**    | Scrim · Grab handle · Body     | Detents, drag-to-dismiss threshold, spring                          |
| **Drawer Shell**   | Scrim · Panel                  | Edge, width, gesture dismissal                                      |

**7 templates.**

---

## 6. Pages

Each is a template plus organisms.

| Page              | Template       | Organisms                                                                               |
| ----------------- | -------------- | --------------------------------------------------------------------------------------- |
| **Browse**        | Split Layout   | Sidebar, Collection Grid, Timeline, Map Surface, Toolbar                                |
| **Editor**        | Split Layout   | Image Canvas, Tool Dock, Control Surface, Adjustments Panel, Inspector Panel, Filmstrip |
| **Document**      | Split Layout   | Sidebar, Rich Text Editor, Backlinks Panel, Version History Panel                       |
| **Preview**       | App Shell      | Preview Surface                                                                         |
| **Search**        | App Shell      | Search                                                                                  |
| **Board**         | App Shell      | Kanban Board                                                                            |
| **Chat**          | Split Layout   | Chat, Thread Panel                                                                      |
| **Notifications** | App Shell      | Notification Feed                                                                       |
| **Settings**      | Settings Shell | Settings Section, Device List, User Management                                          |
| **Admin**         | Settings Shell | Pipeline Monitor, Setup Wizard, Backup Monitor, Diagnostics                             |
| **Sign In**       | App Shell      | Form Field, Button, Banner                                                              |
| **Pairing**       | App Shell      | Pair Device                                                                             |
| **TV Timeline**   | Tab Shell      | Timeline, Collection Grid                                                               |
| **TV Viewer**     | App Shell      | Preview Surface                                                                         |
| **TV Map**        | Tab Shell      | Map Surface                                                                             |

**15 page types.**

---

## 7. Design order

Each wave depends only on the ones before it.

| Wave  | What                                                  | Count |
| ----- | ----------------------------------------------------- | ----- |
| **0** | Tokens — color, type, spacing, radius, shadow, motion | —     |
| **1** | Atoms · Actions and Content                           | 10    |
| **2** | Atoms · Form, Media, Feedback                         | 12    |
| **3** | Molecules L1 · Form, Selection, Feedback              | 19    |
| **4** | Molecules L1 · Overlays, Structure, Plots, Media      | 25    |
| **5** | Molecules L2                                          | 24    |
| **6** | Templates                                             | 7     |
| **7** | Organisms · Collections, Navigation, Inspectors       | 23    |
| **8** | Organisms · Modals, Editing, Map, Comms, Config       | 29    |
| **9** | Pages                                                 | 15    |

Waves 1 and 2 are the whole foundation and the smallest amount of work — 22 elements. Wave 6 (templates) comes before organisms because every modal depends on Overlay Shell.

**Totals: 22 atoms · 68 molecules · 52 organisms · 7 templates · 15 pages.**

---

## 8. What to specify per tier

Applied consistently, this is what makes the guide usable rather than decorative.

**Atoms** — every variant × every size × every state, as a matrix. Token references only, never raw values. Minimum hit area. Focus ring treatment.

**Molecules** — internal spacing between atoms. Overflow behavior. Which atom variants are permitted inside (a Banner uses ghost Buttons, not primary). Empty and loading appearance.

**Organisms** — layout at each breakpoint. Data states: loading, empty, error, partial. Scroll and virtualization behavior. Keyboard traversal order.

**Templates** — region min/max sizes. Collapse and reflow order. Overlay stacking.

**Pages** — which organisms occupy which regions, and what changes per breakpoint.
