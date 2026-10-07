use super::*;

impl MapleApp {
    pub(super) fn choose_export(&mut self, context: &egui::Context) {
        if self.export_picker.is_some() {
            return;
        }
        let (Some(photo), Some(document)) = (self.selected.clone(), self.document.clone()) else {
            return;
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        let context = context.clone();
        std::thread::spawn(move || {
            let path = rfd::FileDialog::new()
                .add_filter("JPEG", &["jpg", "jpeg"])
                .add_filter("PNG", &["png"])
                .set_file_name("maple-export.jpg")
                .save_file();
            let _ = sender.send(path.map(|path| (photo, document.model, path)));
            context.request_repaint();
        });
        self.export_picker = Some(receiver);
    }
}
