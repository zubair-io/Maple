use super::*;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn the_icon_decode_runs_while_the_gpu_context_is_being_created() {
    let (started, decoding) = mpsc::channel();
    let (created_while_decoding, icon) = overlapped(
        move || {
            started.send(()).unwrap();
            egui::ColorImage::example()
        },
        || decoding.recv_timeout(Duration::from_secs(10)).is_ok(),
    );
    assert!(
        created_while_decoding,
        "the decode had not started when the GPU context was created"
    );
    assert_eq!(icon.image().size, egui::ColorImage::example().size);
}

#[test]
fn the_icon_the_app_decodes_is_the_canonical_512_pixel_one() {
    assert_eq!(StartupIcon::begin().image().size, [512, 512]);
}

#[test]
fn a_failed_decode_surfaces_its_own_panic_message() {
    let panic = std::panic::catch_unwind(|| {
        StartupIcon::start(|| panic!("the icon file is damaged")).image()
    })
    .unwrap_err();
    assert_eq!(
        panic.downcast_ref::<&str>(),
        Some(&"the icon file is damaged")
    );
}
