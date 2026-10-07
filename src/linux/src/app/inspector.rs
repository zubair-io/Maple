use super::*;
use crate::{
    controls::{Control, Group},
    library::MediaKind,
};

impl MapleApp {
    pub(super) fn inspector(&mut self, context: &egui::Context) {
        let mut changed = false;
        let mut finished = false;
        egui::Area::new(egui::Id::new("editor-tools"))
            .anchor(egui::Align2::RIGHT_CENTER, [-12.0, 0.0])
            .show(context, |ui| {
                super::style::panel("surface")
                    .rounding(18.0)
                    .show(ui, |ui| {
                        ui.vertical(|ui| {
                            for group in [
                                Group::Light,
                                Group::Color,
                                Group::Effects,
                                Group::Detail,
                                Group::Film,
                            ] {
                                super::style::tool_button(ui, &mut self.active_group, group);
                            }
                        });
                    });
            });
        egui::Window::new("Tool controls")
            .id(egui::Id::new("inspector"))
            .title_bar(false)
            .resizable(false)
            .collapsible(false)
            .movable(false)
            .anchor(egui::Align2::RIGHT_CENTER, [-108.0, 0.0])
            .fixed_size([300.0, 480.0])
            .frame(super::style::panel("surface").rounding(18.0))
            .show(context, |ui| {
                if self.cloud.downloading {
                    ui.disable();
                }
                ui.label(
                    egui::RichText::new(format!("{:?}", self.active_group).to_uppercase())
                        .strong()
                        .color(super::style::color("primary")),
                );
                ui.separator();
                let Some(document) = &mut self.document else {
                    return;
                };
                let raster = self
                    .selected
                    .as_ref()
                    .is_some_and(|p| p.kind == MediaKind::Raster);
                let before = document.clone();
                ui.horizontal(|ui| {
                    ui.label("Profile");
                    changed |= ui
                        .selectable_value(
                            &mut document.model.profile,
                            raw_core::types::adjustment::Profile::Auto,
                            "Auto",
                        )
                        .changed();
                    changed |= ui
                        .selectable_value(
                            &mut document.model.profile,
                            raw_core::types::adjustment::Profile::Neutral,
                            "Neutral",
                        )
                        .changed();
                });
                changed |= ui
                    .add(egui::Slider::new(&mut document.culling.rating, 0..=5).text("Rating"))
                    .changed();
                ui.horizontal(|ui| {
                    for (flag, label) in [
                        (crate::sidecar::Flag::Unflagged, "Unflagged"),
                        (crate::sidecar::Flag::Pick, "Pick"),
                        (crate::sidecar::Flag::Reject, "Reject"),
                    ] {
                        changed |= ui
                            .selectable_value(&mut document.culling.flag, flag, label)
                            .changed();
                    }
                });
                finished |= changed && !ui.input(|input| input.pointer.primary_down());
                egui::ScrollArea::vertical().show(ui, |ui| {
                    for group in [
                        Group::Light,
                        Group::Color,
                        Group::Effects,
                        Group::Film,
                        Group::Detail,
                    ]
                    .into_iter()
                    .filter(|group| *group == self.active_group)
                    {
                        ui.scope(|ui| {
                            ui.spacing_mut().interact_size.y = 18.0;
                            ui.spacing_mut().item_spacing.y = 4.0;
                            if group == Group::Film {
                                changed |= super::film_controls::picker(ui, &mut document.model);
                            }
                            for &control in Control::ALL
                                .iter()
                                .filter(|control| control.group() == group)
                            {
                                let wb = matches!(control, Control::Temperature | Control::Tint);
                                let enabled = (!wb || self.white_balance.is_some())
                                    && (control != Control::FilmStrength
                                        || !document.model.film_look.is_empty())
                                    && !(raster
                                        && matches!(control, Control::Contrast | Control::Whites));
                                let mut value = if wb {
                                    self.white_balance
                                        .as_ref()
                                        .map(|reference| {
                                            let (temperature, tint) =
                                                reference.values(&document.model);
                                            if control == Control::Temperature {
                                                temperature
                                            } else {
                                                tint
                                            }
                                        })
                                        .unwrap_or_else(|| control.get(&document.model))
                                } else {
                                    control.get(&document.model)
                                };
                                let (min, max) = control.spec().range;
                                ui.horizontal(|ui| {
                                    ui.label(control.label());
                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            ui.monospace(if control == Control::Exposure {
                                                format!("{value:.2}")
                                            } else {
                                                format!("{value:.0}")
                                            });
                                        },
                                    );
                                });
                                ui.spacing_mut().slider_width = ui.available_width();
                                let response = ui.add_enabled(
                                    enabled,
                                    egui::Slider::new(&mut value, min..=max)
                                        .clamping(egui::SliderClamping::Edits)
                                        .show_value(false)
                                        .step_by(control.step() as f64),
                                );
                                ui.ctx().accesskit_node_builder(response.id, |node| {
                                    node.set_label(control.label())
                                });
                                response.widget_info(|| {
                                    egui::WidgetInfo::slider(enabled, value as f64, control.label())
                                });
                                if response.changed() {
                                    let result = if wb {
                                        self.white_balance
                                            .as_ref()
                                            .expect("enabled WB reference")
                                            .edit(&mut document.model, control, value)
                                    } else {
                                        control.set(&mut document.model, value)
                                    };
                                    match result {
                                        Ok(()) => changed = true,
                                        Err(error) => self.error = Some(error),
                                    }
                                }
                                finished |= response.drag_stopped()
                                    || (response.changed() && !response.dragged());
                            }
                        });
                    }
                });
                if changed && self.before_edit.is_none() {
                    self.before_edit = Some(before);
                }
            });
        if changed {
            self.changed();
            self.render();
        }
        finished |=
            self.before_edit.is_some() && !context.input(|input| input.pointer.primary_down());
        if finished {
            if let Some(before) = self.before_edit.take() {
                self.history.push(before);
            }
        }
    }
}
