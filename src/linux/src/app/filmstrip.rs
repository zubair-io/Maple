use super::MapleApp;
use crate::library::Photo;
use eframe::egui;

const THUMBNAIL_BOX: egui::Vec2 = egui::vec2(72.0, 46.0);
const UNAVAILABLE_LABEL: &str = "Preview unavailable";

#[derive(Clone, Copy, PartialEq)]
struct StyleKey {
    pixels_per_point: f32,
    button_padding: egui::Vec2,
    item_spacing: f32,
    interact_height: f32,
    button_font_size: f32,
}

impl StyleKey {
    fn of(ui: &egui::Ui) -> Self {
        let spacing = ui.spacing();
        Self {
            pixels_per_point: ui.ctx().pixels_per_point(),
            button_padding: spacing.button_padding,
            item_spacing: spacing.item_spacing.x,
            interact_height: spacing.interact_size.y,
            button_font_size: egui::TextStyle::Button.resolve(ui.style()).size,
        }
    }
}

#[derive(Clone, Copy)]
struct Cell {
    left: f32,
    top: f32,
    size: egui::Vec2,
}

#[derive(Default)]
struct Measured {
    key: Option<(u64, u64, StyleKey)>,
    cells: Vec<Cell>,
    width: f32,
    height: f32,
}

#[derive(Default)]
struct NameSizes {
    key: Option<(u64, StyleKey)>,
    names: Vec<egui::Vec2>,
    unavailable: egui::Vec2,
    #[cfg(test)]
    measured: usize,
}

impl NameSizes {
    fn refresh(&mut self, ui: &egui::Ui, photos: &[Photo], key: (u64, StyleKey)) {
        if self.key == Some(key) && self.names.len() == photos.len() {
            return;
        }
        self.names = photos
            .iter()
            .map(|photo| {
                button_size(
                    ui,
                    &photo.path.file_name().unwrap_or_default().to_string_lossy(),
                )
            })
            .collect();
        self.unavailable = button_size(ui, UNAVAILABLE_LABEL);
        self.key = Some(key);
        #[cfg(test)]
        {
            self.measured += photos.len() + 1;
        }
    }
}

#[derive(Default)]
pub(super) struct Filmstrip {
    order_revision: u64,
    thumbnail_revision: u64,
    names: NameSizes,
    measured: Measured,
    focused: Option<usize>,
}

impl Filmstrip {
    #[cfg(test)]
    pub(super) fn names_measured(&self) -> usize {
        self.names.measured
    }

    pub(super) fn photos_changed(&mut self) {
        self.order_revision += 1;
    }

    pub(super) fn thumbnails_changed(&mut self) {
        self.thumbnail_revision += 1;
    }

    fn visible(&self, left: f32, right: f32) -> std::ops::Range<usize> {
        let cells = &self.measured.cells;
        let first = cells.partition_point(|cell| cell.left + cell.size.x < left);
        let end = cells.partition_point(|cell| cell.left <= right);
        first..end.max(first)
    }

    // Tab needs the neighbouring cell laid out, egui drops focus from a cell it does not see, and
    // Tab or Shift+Tab entering the strip lands on its first or last cell.
    fn laid_out(&self, visible: std::ops::Range<usize>) -> Vec<usize> {
        let len = self.measured.cells.len();
        let beside = if visible.is_empty() {
            0..0
        } else {
            visible.start.saturating_sub(1)..(visible.end + 1).min(len)
        };
        let kept = self
            .focused
            .map_or(0..0, |index| index.saturating_sub(1)..(index + 2).min(len));
        let ends = [0, len.saturating_sub(1)].into_iter().filter(|_| len > 0);
        let mut indices: Vec<usize> = beside.chain(kept).chain(ends).collect();
        indices.sort_unstable();
        indices.dedup();
        indices
    }
}

fn button_size(ui: &egui::Ui, text: &str) -> egui::Vec2 {
    let padding = ui.spacing().button_padding;
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Extend),
        f32::INFINITY,
        egui::TextStyle::Button,
    );
    let size = galley.size() + 2.0 * padding;
    egui::vec2(size.x, size.y.max(ui.spacing().interact_size.y))
}

fn cell_size(
    names: &NameSizes,
    index: usize,
    thumbnail: Option<&Result<egui::TextureHandle, String>>,
) -> egui::Vec2 {
    match thumbnail {
        Some(Ok(texture)) => egui::Image::new(texture)
            .fit_to_exact_size(THUMBNAIL_BOX)
            .calc_size(THUMBNAIL_BOX, Some(texture.size_vec2())),
        Some(Err(_)) => names.unavailable,
        None => names.names[index],
    }
}

fn measure(
    names: &NameSizes,
    photos: &[Photo],
    thumbnails: &std::collections::HashMap<std::path::PathBuf, Result<egui::TextureHandle, String>>,
    key: (u64, u64, StyleKey),
) -> Measured {
    let style = key.2;
    let sizes: Vec<egui::Vec2> = photos
        .iter()
        .enumerate()
        .map(|(index, photo)| cell_size(names, index, thumbnails.get(&photo.path)))
        .collect();
    let placements = sizes
        .iter()
        .scan((0.0_f32, style.interact_height), |(left, row), size| {
            let top = ((*row - size.y) / 2.0).max(0.0);
            let placed = (*left, top);
            *left += size.x + style.item_spacing;
            *row = row.max(size.y);
            Some(placed)
        });
    let cells: Vec<Cell> = placements
        .zip(&sizes)
        .map(|((left, top), &size)| Cell { left, top, size })
        .collect();
    Measured {
        key: Some(key),
        width: cells.last().map_or(0.0, |cell| cell.left + cell.size.x),
        height: sizes
            .iter()
            .fold(style.interact_height, |height, size| height.max(size.y)),
        cells,
    }
}

impl MapleApp {
    pub(super) fn local_filmstrip(&mut self, ui: &mut egui::Ui) -> Option<Photo> {
        let photos: &[Photo] = self
            .folder
            .as_ref()
            .map_or(&[], |folder| folder.photos.as_slice());
        let style = StyleKey::of(ui);
        self.filmstrip
            .names
            .refresh(ui, photos, (self.filmstrip.order_revision, style));
        let key = (
            self.filmstrip.order_revision,
            self.filmstrip.thumbnail_revision,
            style,
        );
        if self.filmstrip.measured.key != Some(key)
            || self.filmstrip.measured.cells.len() != photos.len()
        {
            self.filmstrip.measured =
                measure(&self.filmstrip.names, photos, &self.thumbnail_cache, key);
        }
        let strip = &self.filmstrip;
        let focused = std::cell::Cell::new(None);
        let mut selected = None;
        egui::ScrollArea::horizontal().show(ui, |ui| {
            ui.set_min_size(egui::vec2(strip.measured.width, strip.measured.height));
            let origin = ui.cursor().min;
            let clip = ui.clip_rect();
            let visible = strip.visible(clip.min.x - origin.x, clip.max.x - origin.x);
            let mut next_id_index = 0;
            for index in strip.laid_out(visible) {
                ui.skip_ahead_auto_ids(index - next_id_index);
                next_id_index = index + 1;
                let photo = &photos[index];
                let cell = strip.measured.cells[index];
                let rect =
                    egui::Rect::from_min_size(origin + egui::vec2(cell.left, cell.top), cell.size);
                let builder = egui::UiBuilder::new()
                    .max_rect(rect)
                    .layout(egui::Layout::left_to_right(egui::Align::Center));
                let clicked = ui
                    .scope_builder(builder, |ui| {
                        let name = photo.path.file_name().unwrap_or_default().to_string_lossy();
                        let selected_now = self
                            .selected
                            .as_ref()
                            .is_some_and(|current| current.path == photo.path);
                        let response = match self.thumbnail_cache.get(&photo.path) {
                            Some(Ok(texture)) => ui.add(
                                egui::Image::new(texture)
                                    .fit_to_exact_size(THUMBNAIL_BOX)
                                    .rounding(5.0)
                                    .sense(egui::Sense::click()),
                            ),
                            Some(Err(error)) => ui.button(UNAVAILABLE_LABEL).on_hover_text(error),
                            None => ui.button(name.as_ref()),
                        }
                        .on_hover_text(name.as_ref());
                        if ui.memory(|memory| memory.has_focus(response.id)) {
                            focused.set(Some(index));
                        }
                        if ui.clip_rect().intersects(response.rect)
                            && !self.thumbnail_pending.contains(&photo.path)
                            && !self.thumbnail_cache.contains_key(&photo.path)
                            && self.thumbnails.request(self.thumbnail_epoch, photo.clone())
                        {
                            self.thumbnail_pending.insert(photo.path.clone());
                        }
                        response.widget_info(|| {
                            egui::WidgetInfo::labeled(
                                egui::WidgetType::Button,
                                response.enabled(),
                                format!("Open {name}"),
                            )
                        });
                        if selected_now {
                            ui.painter().rect_stroke(
                                response.rect,
                                5.0,
                                egui::Stroke::new(2.0_f32, super::style::color("primary")),
                            );
                        }
                        response.clicked()
                    })
                    .inner;
                if clicked {
                    selected = Some(photo.clone());
                }
            }
        });
        self.filmstrip.focused = focused.get();
        selected
    }
}
