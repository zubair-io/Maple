use eframe::egui;
use raw_core::{
    film_catalog::{FilmCategory, FILM_CATALOG},
    types::adjustment::AdjustmentModel,
};

pub(super) fn picker(ui: &mut egui::Ui, model: &mut AdjustmentModel) -> bool {
    let selected = FILM_CATALOG
        .iter()
        .find(|entry| entry.id == model.film_look)
        .map(|entry| entry.name)
        .unwrap_or(if model.film_look.is_empty() {
            "None"
        } else {
            "Unavailable look"
        });
    let mut changed = false;
    egui::ComboBox::from_label("Film look")
        .selected_text(selected)
        .height(280.0)
        .show_ui(ui, |ui| {
            changed |= ui
                .selectable_value(&mut model.film_look, String::new(), "None")
                .changed();
            for (category, label) in [
                (FilmCategory::BlackWhite, "Black & white"),
                (FilmCategory::CinemaPrint, "Cinema print"),
                (FilmCategory::ColorNegative, "Color negative"),
                (FilmCategory::ConsumerVintage, "Consumer & vintage"),
                (FilmCategory::Instant, "Instant"),
                (FilmCategory::Slide, "Slide"),
            ] {
                ui.separator();
                ui.strong(label);
                for entry in FILM_CATALOG
                    .iter()
                    .filter(|entry| entry.category == category)
                {
                    changed |= ui
                        .selectable_value(&mut model.film_look, entry.id.to_owned(), entry.name)
                        .changed();
                }
            }
        });
    changed
}
