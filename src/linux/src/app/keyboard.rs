use super::*;

impl MapleApp {
    pub(super) fn history_shortcuts(&mut self, context: &egui::Context) {
        if self.cloud.active
            || self.cloud.downloading
            || self.before_edit.is_some()
            || super::zoom::text_is_focused(context)
        {
            return;
        }
        let redo = context.input_mut(|input| {
            let index = input.events.iter().position(|event| {
                matches!(event, egui::Event::Key {
                    key: egui::Key::Z, pressed: true, modifiers, ..
                } if modifiers.matches_exact(egui::Modifiers::COMMAND)
                    || modifiers.matches_exact(egui::Modifiers::COMMAND | egui::Modifiers::SHIFT))
            })?;
            let egui::Event::Key { modifiers, .. } = input.events.remove(index) else {
                unreachable!("matched key event");
            };
            Some(modifiers.shift)
        });
        if let Some(redo) = redo {
            let available = if redo { &self.redo } else { &self.history };
            if !available.is_empty() {
                self.undo(redo);
            }
        }
    }
}

pub(super) fn plain_key_pressed(input: &egui::InputState, key: egui::Key) -> bool {
    input.events.iter().any(|event| {
        matches!(event, egui::Event::Key { key: pressed, pressed: true, modifiers, .. }
            if *pressed == key && modifiers.is_none())
    })
}
