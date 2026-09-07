// editor-shell.imports.ts — the standalone components `EditorShellComponent`
// projects into its template.
//
// Split out of `editor-shell.component.ts` in #3413 to keep that file under
// CONTRIBUTING.md's 570-line headroom budget — the same reason the chrome,
// keyboard, scrub, undo, wheel, hud, panels and route helpers already live
// in siblings here. Every entry but one is referenced
// only by the template, so their import statements and the array itself
// carry no information the component body needs.
//
// `ControlCardComponent` is deliberately NOT here: the component class also
// holds a `@ViewChild(ControlCardComponent)`, so it needs the symbol in
// scope anyway and stays spelled out at the decorator.

import { NgTemplateOutlet } from '@angular/common';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { FilmstripComponent } from '../../components/filmstrip/filmstrip.component';
import { ImageCanvasComponent } from '../../components/image-canvas/image-canvas.component';
import { HistogramComponent } from '../../components/scopes/histogram.component';
import { ScopesPanelComponent } from '../../components/scopes/scopes-panel.component';
import { ToolDockComponent } from '../../components/editor/tool-dock.component';
import { ValueHudComponent } from '../../components/editor/value-hud.component';
import { ToneCurveComponent } from '../../components/develop/tone-curve.component';
import { WbPadComponent } from '../../components/develop/wb-pad.component';
import { ColorGradingPanelComponent } from '../../components/develop/color-grading-panel.component';
import { FilmPanelComponent } from '../../components/editor/film-panel.component';
import { LensCorrectionsPanelComponent } from '../../components/editor/lens-corrections-panel.component';
import { GeometryPanelComponent } from '../../components/editor/geometry-panel.component';
import { DemosaicPanelComponent } from '../../components/editor/demosaic-panel.component';
import { CropToolbarComponent } from '../../editor/crop-toolbar.component';
import { MaskPanelComponent } from '../../components/mask-panel/mask-panel.component';
import { RetouchPanelComponent } from '../../components/retouch-panel/retouch-panel.component';
import { PresetsPanelComponent } from '../../editor/presets/presets-panel.component';
import { SubParamRowComponent } from '../../editor/sub-param-row.component';
import { DragBarComponent } from '../../editor/drag-bar.component';
import { ValueChipComponent } from '../../editor/value-chip.component';
import { InfoPanelComponent } from '../../info/info-panel.component';
import { MuiSheetShellComponent } from '../../ui/sheet-shell/mui-sheet-shell.component';
import { ExportDialogComponent } from '../../export/export-dialog.component';
import { MuiCommandMenuComponent } from '../../ui/command-menu/mui-command-menu.component';

/** Template-only standalone imports for `EditorShellComponent`. */
export const EDITOR_SHELL_IMPORTS = [
  NgTemplateOutlet,
  MapleIconComponent,
  FilmstripComponent,
  ImageCanvasComponent,
  HistogramComponent,
  ScopesPanelComponent,
  ToolDockComponent,
  ValueHudComponent,
  ToneCurveComponent,
  WbPadComponent,
  ColorGradingPanelComponent,
  FilmPanelComponent,
  LensCorrectionsPanelComponent,
  GeometryPanelComponent,
  DemosaicPanelComponent,
  CropToolbarComponent,
  MaskPanelComponent,
  RetouchPanelComponent,
  PresetsPanelComponent,
  SubParamRowComponent,
  DragBarComponent,
  ValueChipComponent,
  InfoPanelComponent,
  MuiSheetShellComponent,
  ExportDialogComponent,
  MuiCommandMenuComponent,
] as const;
