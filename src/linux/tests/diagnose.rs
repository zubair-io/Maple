use eframe::egui_wgpu::wgpu;
use maple_linux::diagnose::{
    gpu, libraries, portal, render, session, system_from, Finding, Portal, Session, Status,
};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

fn environment(pairs: &[(&'static str, &str)]) -> impl Fn(&str) -> Option<OsString> {
    let owned: Vec<(&str, OsString)> = pairs
        .iter()
        .map(|(key, value)| (*key, OsString::from(value)))
        .collect();
    move |name| {
        owned
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.clone())
    }
}

fn statuses(findings: &[Finding]) -> Vec<(&'static str, Status)> {
    findings
        .iter()
        .map(|finding| (finding.check, finding.status))
        .collect()
}

#[test]
fn a_set_wayland_display_is_used_and_resolves_in_the_runtime_directory() {
    let (selected, finding) = session(
        environment(&[
            ("WAYLAND_DISPLAY", "wayland-7"),
            ("XDG_RUNTIME_DIR", "/run/user/4242"),
            ("DISPLAY", ":3.0"),
        ]),
        |path| path == Path::new("/run/user/4242/wayland-7"),
    );
    assert_eq!((selected, finding.status), (Session::Wayland, Status::Ok));
}

#[test]
fn an_unreachable_wayland_display_is_a_problem_even_with_x11_available() {
    let (selected, finding) = session(
        environment(&[("WAYLAND_DISPLAY", "/srv/absent"), ("DISPLAY", ":0")]),
        |path| path == Path::new("/tmp/.X11-unix/X0"),
    );
    assert_eq!(
        (selected, finding.status),
        (Session::Wayland, Status::Problem)
    );
}

#[test]
fn an_inherited_wayland_socket_selects_wayland_without_probing() {
    let (selected, finding) = session(environment(&[("WAYLAND_SOCKET", "5")]), |_| false);
    assert_eq!((selected, finding.status), (Session::Wayland, Status::Ok));
}

#[test]
fn local_x11_displays_are_probed_by_number() {
    for display in [":12", "unix:12", ":12.1"] {
        let (selected, finding) = session(environment(&[("DISPLAY", display)]), |path| {
            path == Path::new("/tmp/.X11-unix/X12")
        });
        assert_eq!(
            (selected, finding.status),
            (Session::X11, Status::Ok),
            "{display}"
        );
    }
    let (_, finding) = session(environment(&[("DISPLAY", ":13")]), |_| false);
    assert_eq!(finding.status, Status::Problem);
}

#[test]
fn remote_x11_is_not_probed_and_invalid_or_missing_displays_are_problems() {
    let probed = std::cell::RefCell::new(Vec::<PathBuf>::new());
    let (selected, finding) = session(environment(&[("DISPLAY", "workstation:0")]), |path| {
        probed.borrow_mut().push(path.into());
        false
    });
    assert_eq!((selected, finding.status), (Session::X11, Status::Ok));
    assert!(probed.borrow().is_empty());

    for display in [":", "foo", ":abc"] {
        let (selected, finding) = session(environment(&[("DISPLAY", display)]), |_| true);
        assert_eq!(
            (selected, finding.status),
            (Session::None, Status::Problem),
            "{display}"
        );
    }
    let (selected, finding) = session(environment(&[]), |_| true);
    assert_eq!((selected, finding.status), (Session::None, Status::Problem));
}

#[test]
fn os_release_values_are_reduced_to_identifier_characters() {
    let finding = system_from("ID=ubuntu\nVERSION_ID=\"24.04\"\n");
    assert!(
        finding.detail.starts_with("ubuntu 24.04 "),
        "{}",
        finding.detail
    );
    let hostile = system_from("ID=\"/home/alice/../x\"\nVERSION_ID=\"1 $(id)\"\n");
    assert!(
        hostile.detail.starts_with("unknown unknown "),
        "{}",
        hostile.detail
    );
}

#[test]
fn only_libraries_the_selected_session_loads_are_problems() {
    let wayland = libraries(Session::Wayland, |library| !library.starts_with("libX"));
    assert_eq!(
        statuses(&wayland),
        vec![("libraries", Status::Ok), ("libraries", Status::Note)]
    );
    assert!(wayland[1].detail.contains("libXi.so.6"));

    let x11 = libraries(Session::X11, |library| library != "libXcursor.so.1");
    assert_eq!(statuses(&x11), vec![("libraries", Status::Problem)]);
    assert!(x11[0].detail.contains("libXcursor.so.1"));

    let headless = libraries(Session::None, |library| library != "libvulkan.so.1");
    assert_eq!(headless[0].status, Status::Problem);
}

fn adapter(backend: wgpu::Backend, device_type: wgpu::DeviceType) -> wgpu::AdapterInfo {
    wgpu::AdapterInfo {
        name: "llvmpipe (LLVM 20.1.2, 256 bits)".into(),
        vendor: 0x10005,
        device: 0,
        device_type,
        driver: "llvmpipe".into(),
        driver_info: "Mesa 25.2.8".into(),
        backend,
    }
}

#[test]
fn a_vulkan_adapter_passes_and_software_rendering_is_noted() {
    let software = gpu(Ok(adapter(wgpu::Backend::Vulkan, wgpu::DeviceType::Cpu)));
    assert_eq!(
        statuses(&software),
        vec![("vulkan", Status::Ok), ("vulkan", Status::Note)]
    );
    assert!(software[0].detail.contains("llvmpipe"));
    let discrete = gpu(Ok(adapter(
        wgpu::Backend::Vulkan,
        wgpu::DeviceType::DiscreteGpu,
    )));
    assert_eq!(statuses(&discrete), vec![("vulkan", Status::Ok)]);
}

#[test]
fn a_missing_or_non_vulkan_adapter_is_a_problem() {
    let gl = gpu(Ok(adapter(wgpu::Backend::Gl, wgpu::DeviceType::Other)));
    assert_eq!(gl[0].status, Status::Problem);
    let none = gpu(Err("no suitable GPU adapter".into()));
    assert_eq!(statuses(&none), vec![("vulkan", Status::Problem)]);
}

#[test]
fn the_folder_picker_needs_a_portal_or_zenity() {
    assert_eq!(portal(Portal::Available(4), false).status, Status::Ok);
    assert_eq!(portal(Portal::Unavailable, true).status, Status::Note);
    assert_eq!(portal(Portal::Unavailable, false).status, Status::Problem);
    assert_eq!(portal(Portal::Activatable, false).status, Status::Ok);
    assert_eq!(portal(Portal::NotProbed, false).status, Status::Note);
}

#[test]
fn the_report_counts_problems() {
    let report = render(&[
        portal(Portal::Unavailable, false),
        portal(Portal::Available(4), false),
    ]);
    assert!(report.contains("[problem] portal:"));
    assert!(report.contains("[ok] portal:"));
    assert!(report.ends_with("problems: 1\n"));
}

#[test]
fn the_binary_reports_without_a_window_and_omits_environment_values() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_maple-linux"))
        .arg("--diagnose")
        .env_clear()
        .env("WAYLAND_DISPLAY", "/nonexistent/private-socket-4d1c")
        .env("DISPLAY", ":93")
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            "unix:path=/nonexistent/private-bus-77",
        )
        .env("PATH", "/nonexistent/private-path-5e")
        .output()
        .unwrap();
    let report = String::from_utf8(output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1), "{report}");
    assert!(report.contains("[problem] session:"), "{report}");
    assert!(report.contains("[problem] portal:"), "{report}");
    for private in ["private-socket", "private-bus", "private-path", ":93"] {
        assert!(!report.contains(private), "{private} leaked into {report}");
    }
}
