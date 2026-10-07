//! Read Maple's single-sourced UI colours directly in the native Rust shell.
use crate::controls::Group;
use eframe::egui;

pub(super) fn color(name: &str) -> egui::Color32 {
    let value = raw_core::ui_tokens::COLOR_TOKENS
        .iter()
        .find(|token| token.name == name)
        .expect("canonical UI token")
        .value;
    let channel =
        |start| u8::from_str_radix(&value[start..start + 2], 16).expect("canonical hex color");
    egui::Color32::from_rgb(channel(1), channel(3), channel(5))
}

pub(super) fn apply(context: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = color("surface");
    visuals.window_fill = color("bg");
    visuals.override_text_color = Some(color("text_main"));
    visuals.selection.bg_fill = color("primary");
    visuals.widgets.noninteractive.bg_stroke.color = color("border");
    visuals.widgets.inactive.bg_fill = color("surface_alt");
    visuals.widgets.inactive.weak_bg_fill = color("surface");
    visuals.widgets.inactive.bg_stroke = egui::Stroke::new(1.0_f32, color("border"));
    visuals.widgets.hovered.bg_fill = color("surface_hover");
    visuals.widgets.hovered.weak_bg_fill = color("surface_hover");
    visuals.widgets.hovered.bg_stroke = egui::Stroke::new(1.0_f32, color("border_hi"));
    visuals.widgets.active.bg_fill = color("surface_hover");
    visuals.widgets.active.weak_bg_fill = color("surface_hover");
    visuals.widgets.active.bg_stroke = egui::Stroke::new(1.0_f32, color("primary"));
    visuals.selection.stroke = egui::Stroke::new(1.0_f32, color("text_main"));
    visuals.widgets.noninteractive.fg_stroke.color = color("text_muted");
    let radius = raw_core::ui_tokens::RADIUS_TOKENS
        .iter()
        .find(|token| token.name == "md")
        .expect("canonical radius")
        .px as f32;
    for widget in [
        &mut visuals.widgets.inactive,
        &mut visuals.widgets.hovered,
        &mut visuals.widgets.active,
        &mut visuals.widgets.open,
    ] {
        widget.rounding = egui::Rounding::same(radius);
    }
    context.set_visuals(visuals);
    context.style_mut(|style| {
        style.spacing.item_spacing = egui::vec2(8.0, 8.0);
        style.spacing.button_padding = egui::vec2(12.0, 8.0);
        style.spacing.interact_size.y = 32.0;
        style.spacing.slider_width = 150.0;
        style
            .text_styles
            .insert(egui::TextStyle::Body, egui::FontId::proportional(13.0));
        style
            .text_styles
            .insert(egui::TextStyle::Button, egui::FontId::proportional(13.0));
        style
            .text_styles
            .insert(egui::TextStyle::Heading, egui::FontId::proportional(16.0));
    });
}

pub(super) fn panel(fill: &str) -> egui::Frame {
    egui::Frame::none()
        .fill(color(fill))
        .inner_margin(egui::Margin::same(12.0))
        .stroke(egui::Stroke::new(1.0_f32, color("border")))
}

pub(super) fn tool_button(ui: &mut egui::Ui, group: &mut Group, item: Group) -> egui::Response {
    let selected = *group == item;
    let (rect, response) = ui.allocate_exact_size(egui::vec2(76.0, 56.0), egui::Sense::click());
    let visuals = ui.style().interact_selectable(&response, selected);
    ui.painter().rect(
        rect,
        egui::Rounding::same(8.0),
        if selected {
            color("primary_dim")
        } else {
            visuals.bg_fill
        },
        visuals.bg_stroke,
    );
    let center = egui::pos2(rect.center().x, rect.top() + 17.0);
    let ink = if selected {
        color("primary")
    } else {
        color("text_muted")
    };
    let stroke = egui::Stroke::new(1.5_f32, ink);
    match item {
        Group::Light => {
            ui.painter().circle_stroke(center, 3.0, stroke);
            for (x, y) in [
                (0., -8.),
                (0., 8.),
                (-8., 0.),
                (8., 0.),
                (-5.7, -5.7),
                (5.7, -5.7),
                (-5.7, 5.7),
                (5.7, 5.7),
            ] {
                ui.painter().line_segment(
                    [
                        center + egui::vec2(x * 0.62, y * 0.62),
                        center + egui::vec2(x, y),
                    ],
                    stroke,
                );
            }
        }
        Group::Color => {
            ui.painter()
                .circle_stroke(center - egui::vec2(3.0, 0.0), 5.0, stroke);
            ui.painter()
                .circle_stroke(center + egui::vec2(3.0, 0.0), 5.0, stroke);
        }
        Group::Effects => {
            ui.painter().rect_stroke(
                egui::Rect::from_center_size(center, egui::vec2(16.0, 16.0)),
                4.0,
                stroke,
            );
            ui.painter().circle_stroke(center, 3.0, stroke);
        }
        Group::Detail => {
            let points = [
                center + egui::vec2(-9.0, 5.0),
                center + egui::vec2(-5.0, 5.0),
                center + egui::vec2(0.0, -7.0),
                center + egui::vec2(5.0, 5.0),
                center + egui::vec2(9.0, 5.0),
            ];
            ui.painter().add(egui::Shape::line(points.to_vec(), stroke));
        }
        Group::Film => {
            let film = egui::Rect::from_center_size(center, egui::vec2(18.0, 14.0));
            ui.painter().rect_stroke(film, 2.0, stroke);
            for x in [-5.0, 0.0, 5.0] {
                for y in [-4.0, 4.0] {
                    ui.painter()
                        .circle_filled(center + egui::vec2(x, y), 0.8, ink);
                }
            }
        }
    }
    ui.painter().text(
        egui::pos2(rect.center().x, rect.bottom() - 10.0),
        egui::Align2::CENTER_CENTER,
        format!("{item:?}"),
        egui::FontId::proportional(11.0),
        if selected {
            color("text_main")
        } else {
            color("text_muted")
        },
    );
    response.widget_info(|| {
        egui::WidgetInfo::labeled(
            egui::WidgetType::Button,
            response.enabled(),
            format!("{item:?}"),
        )
    });
    if response.clicked() {
        *group = item;
    }
    response
}
