use super::MapleApp;
use crate::library::PhotoSort;
use eframe::egui;

impl MapleApp {
    pub(super) fn sort_controls(&mut self, ui: &mut egui::Ui) {
        let previous = (self.photo_sort, self.sort_descending);
        egui::ComboBox::from_label("Sort by")
            .selected_text(self.photo_sort.label())
            .show_ui(ui, |ui| {
                for sort in [PhotoSort::Filename, PhotoSort::Modified, PhotoSort::Size] {
                    if ui
                        .selectable_value(&mut self.photo_sort, sort, sort.label())
                        .clicked()
                    {
                        ui.memory_mut(|memory| memory.close_popup());
                    }
                }
            });
        ui.checkbox(&mut self.sort_descending, "Descending");
        if previous != (self.photo_sort, self.sort_descending) {
            self.apply_photo_sort();
        }
    }

    pub(super) fn apply_photo_sort(&mut self) {
        if let Some(folder) = &mut self.folder {
            folder.sort_photos(self.photo_sort, self.sort_descending);
            self.filmstrip.photos_changed();
        }
    }
}
