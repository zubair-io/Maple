use super::film_tests::frame;
use super::filmstrip_tests::{
    editor_over, label_of_photo, open_cells, photo, scroll_events, settle, Nodes,
};
use super::*;
use egui::accesskit::{Action, ActionRequest, NodeId};

fn key(key: egui::Key, modifiers: egui::Modifiers) -> egui::Event {
    egui::Event::Key {
        key,
        physical_key: Some(key),
        pressed: true,
        repeat: false,
        modifiers,
    }
}

fn node_of(nodes: &Nodes, label: &str) -> Option<NodeId> {
    nodes
        .iter()
        .find(|(_, node)| node.label() == Some(label))
        .map(|(id, _)| *id)
}

fn focused(context: &egui::Context) -> Option<u64> {
    context
        .memory(|memory| memory.focused())
        .map(|id| id.value())
}

fn focus_cell(app: &mut MapleApp, context: &egui::Context, photo_index: usize) {
    let nodes = frame(app, context, Vec::new());
    let target = node_of(&nodes, &label_of_photo(photo_index)).expect("the cell is laid out");
    frame(
        app,
        context,
        vec![egui::Event::AccessKitActionRequest(ActionRequest {
            action: Action::Focus,
            target,
            data: None,
        })],
    );
    frame(app, context, Vec::new());
}

fn press(app: &mut MapleApp, context: &egui::Context, event: egui::Event) -> Nodes {
    frame(app, context, vec![event]);
    frame(app, context, Vec::new())
}

fn walk(
    app: &mut MapleApp,
    context: &egui::Context,
    modifiers: egui::Modifiers,
    from: usize,
    steps: usize,
    initial: usize,
) {
    for step in 1..=steps {
        let nodes = press(app, context, key(egui::Key::Tab, modifiers));
        let reached = if modifiers.shift {
            from - step
        } else {
            from + step
        };
        assert_eq!(
            focused(context),
            Some(
                node_of(&nodes, &label_of_photo(reached))
                    .expect("the focused cell is laid out")
                    .0
            ),
            "focus is not on photo {reached} after {step} presses"
        );
        let laid_out = open_cells(&nodes).len();
        assert!(laid_out <= initial + 8, "{laid_out} cells laid out");
    }
}

#[test]
fn tab_and_shift_tab_walk_to_a_photo_far_outside_the_viewport_and_back() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 2_000);
    settle(|events| frame(&mut app, &context, events), Vec::new());
    focus_cell(&mut app, &context, 0);
    let initial = open_cells(&frame(&mut app, &context, Vec::new())).len();

    walk(&mut app, &context, egui::Modifiers::NONE, 0, 60, initial);
    walk(&mut app, &context, egui::Modifiers::SHIFT, 60, 60, initial);
}

#[test]
fn a_focused_cell_keeps_focus_and_enter_when_scrolled_far_out_of_view() {
    let context = egui::Context::default();
    context.enable_accesskit();
    let mut app = editor_over(&context, 2_000);
    settle(|events| frame(&mut app, &context, events), Vec::new());
    focus_cell(&mut app, &context, 3);
    let focus = focused(&context).expect("cell 3 has focus");
    let cells = open_cells(&frame(&mut app, &context, Vec::new()));
    let initial = cells.len();

    let nodes = settle(
        |events| frame(&mut app, &context, events),
        scroll_events(&cells, -60_000.0),
    );

    assert_eq!(focused(&context), Some(focus));
    assert!(open_cells(&nodes).len() <= initial + 8);
    let in_view = open_cells(&nodes);
    assert!(
        !in_view
            .iter()
            .any(|(label, _)| *label == label_of_photo(10)),
        "the strip did not scroll away from the first cells"
    );
    press(
        &mut app,
        &context,
        key(egui::Key::Enter, egui::Modifiers::NONE),
    );
    assert_eq!(
        app.selected.as_ref().map(|photo| photo.path.clone()),
        Some(photo(3).path)
    );
}
