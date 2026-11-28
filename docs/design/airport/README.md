# Airport 2

Airport is the design system for Maple and for the Just Maple client that joins it in this repo. Airport 2 is the version drawn from the One app prototype: one file explorer over a folder tree, with photos, memos, boards, chats and data pages opening as cards beside it. The Sketch file `Airport 2.sketch` is drawn from the same prototype markup, so the two match point for point.

The tokens live in one place, `src/raw-pipeline/raw-core/src/airport_tokens.rs`, and `tools/codegen.sh` writes them out for each platform:

| Platform   | File                                                                       | Use                                                                                               |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Swift      | `src/apple/Packages/MapleUI/Sources/MapleUI/Generated/AirportTokens.swift` | `AirportTokens.dark.base`, `AirportTokens.Typography.display`, `AirportTokens.Panorama.cardPhoto` |
| TypeScript | `src/web/projects/maple-common/src/lib/generated/airport-tokens.ts`        | `AIRPORT_THEMES.dark.base`, `AIRPORT_TYPE.caps`, exported from `maple-common`                     |
| CSS        | `src/web/projects/maple-common/src/lib/generated/_airport-tokens.scss`     | `var(--airport-base)`, `font: var(--airport-title-font)`, loaded by `tokens.scss`                 |

Change a value in the Rust file, run `tools/codegen.sh`, and commit the generated files; the `codegen-drift` job fails otherwise. The older `ui_tokens` set stays as it is until a screen moves to Airport.

## Principles

1. **The content is the interface.** Photos and pages fill the screen. No boxes inside boxes, no toolbar with nothing to do, no chrome in full screen.
2. **Say the verb.** A card heading is **Verb:** object, such as **Edit:** Dusk valley or **Write:** Packing list, never a bare noun.
3. **One signpost per screen.** One big title, Lato Light, left aligned, sentence case, naming the folder you are in. At one column (the rail) there is no title.
4. **Design for the form factor.** Phone, closed Duo, open Duo and desktop each get their own layout. Nothing readable or tappable sits on a fold or a seam.
5. **Colour is state.** Colour says active, changed or done, and nothing else. Errors are words and a glyph in ink, never red.
6. **Quiet by opacity, not by hue.** One ink at four strengths.
7. **Calm by rule.** No banners, pulsing or badges that ask for nothing.
8. **Motion explains where things went.** Cards slide to where they open from; nothing loops.
9. **Precision without looking.** Sliders drag relatively, show their value, detent at neutral and reset with a double tap.
10. **Full screen is a posture.** Any card can go full screen and come back; chrome returns on intent.

Maple's dark palette and minimal chrome are the bar. When a screen in the one app needs more controls than Maple's equivalent, it is wrong.

## Colour

Two themes. Dark is the default and is Maple's warm-stone palette; light is the Studio palette.

| Role                   | Dark                  | Light                 | Use                                                 |
| ---------------------- | --------------------- | --------------------- | --------------------------------------------------- |
| `base`                 | `#1c1917`             | `#ececec`             | The page ground and the grid                        |
| `side`                 | `#211e1b`             | `#e4e4e4`             | The folder list                                     |
| `raised`               | `#262524`             | `#f6f6f6`             | Cards                                               |
| `float`                | `#312c27`             | `#fbfbfb`             | Floating panels, menus, pills                       |
| `photo`                | `#141210`             | `#8a8a8a`             | Behind a photo being judged                         |
| `selected`             | `#40271f`             | `#f0d9d3`             | The current row in a list                           |
| `line`                 | `#39342f`             | `#d2d2d2`             | Hairlines, only where a gap can't separate          |
| `ink`                  | `#dddad8`             | `#141414`             | All text and icons                                  |
| `button` / `on_button` | `#dddad8` / `#1c1917` | `#141414` / `#f6f6f6` | The one primary button                              |
| `active`               | `#e2574c`             | `#a8361f`             | Active tool, current item                           |
| `changed`              | `#e0a93c`             | `#8a5a12`             | Edited values, edited photos                        |
| `done`                 | `#4fb37a`             | `#276b44`             | Finished to-dos, completed uploads                  |
| `marker`               | `#c4493a`             | `#c4493a`             | Selection ring, focus ring, current filmstrip frame |

**Ink steps.** `ink_1` 100 %, `ink_2` 76 %, `ink_3` 64 %, `ink_4` 32 %. Steps 1 to 3 pass 4.5:1 on every surface in both themes (the lowest is 4.9:1); the raw-core tests check this. `ink_4` is for disabled text and decoration only.

**Contrast limits.** Every state colour passes 4.5:1 as text on `base`. Two pairs don't: dark `active` on `float` is 3.75:1, so use it there only for icons and rings, never small text; light `changed` on `selected` is 4.38:1, so show an edited value in a selected row in ink with the amber dot beside it.

## Type

Lato for everything, JetBrains Mono for numbers that line up. All roles scale with Dynamic Type; titles wrap, never truncate.

| Role        | Weight             | Size / line | Tracking         | Use                                                         |
| ----------- | ------------------ | ----------- | ---------------- | ----------------------------------------------------------- |
| `display`   | Light 300          | 64 / 68     | −1.5 %           | A signpost with the screen to itself, with no grid under it |
| `display_s` | Light 300          | 40 / 44     | −1 %             | The folder title while the grid has three or more columns   |
| `title`     | Light 300          | 28 / 34     | 0                | The folder title at two columns, a card's object name       |
| `heading`   | Regular 400        | 20 / 26     | 0                | Section heads inside a card                                 |
| `body`      | Regular 400        | 17 / 26     | 0                | Memo text, messages                                         |
| `callout`   | Regular 400        | 15 / 21     | 0                | List rows, summaries                                        |
| `label`     | Bold 700           | 13 / 16     | 0                | Buttons, slider names, the verb in a heading                |
| `caption`   | Regular 400        | 13 / 18     | 0                | Dates, counts, secondary rows                               |
| `caps`      | Black 900          | 11 / 14     | +12 %, uppercase | Section labels, three words at most                         |
| `value`     | JetBrains Mono 500 | 13 / 16     | 0                | Slider values, EXIF                                         |

Airport 2 uses Light, never Thin. Both apps bundle Lato Light and Black for the display and caps roles (`assets/fonts/` on the web, `Maple/Resources/Fonts/` on Apple). Signed values use a real minus (−) and zero has no sign.

## Space, shape and motion

- **Space:** 4, 8, 12, 16, 24, 32, 48, 64, 96 (`--airport-space-1` to `-9`).
- **Radius:** photos 0, always; controls 8; panels and cards 14; pills 999.
- **Targets:** 44 × 44 pt at least, even when the visible glyph is smaller.
- **Motion:** `tick` 90 ms for value changes; `move` 220 ms `cubic-bezier(0.2, 0, 0, 1)` for a card opening or a panel appearing; `travel` 360 ms `cubic-bezier(0.3, 0, 0, 1)` for the strip scrolling to a card; `reduce` is a 120 ms linear fade used instead of all three under Reduce Motion. Nothing animates while a slider is being dragged.
- **Shadow:** only floating things (panels, menus, pills, the batch bar) have a shadow, `--airport-shadow`. Cards sit flat on the strip.

## Panorama

Everything opens in one horizontal strip of cards.

- On the desktop the folder list (252) and the grid are the first two cards of the strip. The explorer stays pinned at the left edge.
- The newest card always opens right next to the explorer. Older cards move right; the strip scrolls sideways.
- As cards open, the grid shrinks a column at a time (columns of 166 with a 2 pt gap) until it is one bare column of thumbnails with no title: the rail.
- Cards are a fixed width by kind: photo 600, memo 620, chat 480, to-do 440, data 440, thread 400. The gap between cards is 49.
- Snap points are the folder list, the grid, and each open card.
- A thread, a photo opened from a memo, or "chat about this memo" opens beside its parent card.
- Phone shows one card at a time and swipes between them. Closed Duo is the same with the status column on the trailing edge. Open Duo shows two neighbours, one on each screen, never across the fold.

## Explorer

The tree is the data model; every folder works like a Finder folder.

- The folder list holds the tree. Under the current folder it lists that folder's pages, grouped **Chats**, **Notes**, **Boards**, **Data** and **Maple**, then its child folders under **Folders**. Show (Picks, Rejected, Edited) and New stay pinned at the foot of the list.
- Opening a folder shows, in the browse pane: the title row (the folder's name, its count, **Show:** a kind filter, Select, grid or list, More), a summary of what's inside, its child folders, then its photos.
- A folder shows only its own items; nothing rolls up from children. A child folder inherits its parent's permissions and documents.
- Pages (memos, boards, chats, data pages) live only in the folder list; the grid holds photos and video.
- A folder without photos shows its child folders as cover cards that fill the pane, up to three across: the first photo inside, the name in `title`, and what is inside in `caption`.
- Grid tiles have no captions. Hover shows Maple's select circle; selected is a `marker` ring with a check; edited is an amber dot. **Select** in the title row starts a batch, and the batch bar floats at the bottom centre.
- The list view shows the same items as rows with a thumbnail and four columns: Name, Kind, About (counts, or a photo's pick, stars and edited state) and Changed.

## Cards

- A card has a heading of **Verb:** object, the object in `title`, and at most three actions on the right: full screen, more, close.
- One click opens a card at once; there is no double click.
- Card content follows the kind: a memo is text at `body` size with to-do rows; a chat is messages and a composer; a data page is its own list.
- Floating chrome (menus, pills, the composer on a full-screen board) sits on `float` with the shadow and radius 14 (menus) or 999 (pills).
- Buttons: one primary per card, on `button`. Everything else is a quiet text or icon button in ink. Focus is a 2 pt `marker` ring.

## Photo

- **Preview card.** On the desktop and the open Duo, a click on a photo opens Maple's preview screen at card size (600 wide) on `photo`, with a full-screen button. There is no filmstrip in the card and no rating or details panel.
- **Phone and closed Duo.** A tap on a photo opens it full screen at once. The filmstrip swipes through the folder, and Back returns to it.
- **Full screen.** The photo takes the whole screen; chrome is hidden until the pointer moves. A view pill sits at the top and the filmstrip at the bottom, with the current frame 1.5× wide and a `marker` underline. Full-screen photo and the full-screen board look and behave alike.
- **Editing.** Tools float over the photo in panels: a tool rail and one tool panel at a time. The heading says **Edit:** and the photo's name.
- **Sliders.** Name and value on one line, then an 8 pt capsule. Gradient capsules only for Temperature, Tint, Exposure and colour tools. The thumb ring is `marker` when focused and `changed` when the value is off neutral. Drag is relative; a hold gives fine mode; a double tap resets.
- **Rating in a shared roll.** Empty stars by default. Light grey stars show everyone else's average; ink stars show yours. Hover shows all ratings. No "You" or "Rated by" labels.

## Sketch file

`Airport 2.sketch` has four pages:

1. **Foundations:** colour in dark and light, type, space, shape and motion, and the symbols.
2. **Patterns:** Panorama, Explorer, Cards, Photo.
3. **One app · Desktop:** eleven screens, from a folder to a memo in full screen.
4. **One app · Phone and Duo:** phone, closed Duo and open Duo screens.

Colours are document swatches and type roles are text styles named `Theme/role/ink`, so the file and the tokens use the same names.
