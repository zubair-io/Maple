//! `maple-linux --diagnose`: a read-only installation report. It never starts
//! the window, never uses the network and prints no environment values or paths.

use eframe::egui_wgpu::wgpu;
use std::ffi::{CString, OsString};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Ok,
    Note,
    Problem,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Finding {
    pub check: &'static str,
    pub status: Status,
    pub detail: String,
}

impl Finding {
    fn new(check: &'static str, status: Status, detail: impl Into<String>) -> Self {
        Self {
            check,
            status,
            detail: detail.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Session {
    Wayland,
    X11,
    None,
}

pub const BASE_LIBRARIES: &[&str] = &["libvulkan.so.1", "libxkbcommon.so.0"];
pub const WAYLAND_LIBRARIES: &[&str] = &["libwayland-client.so.0"];
pub const X11_LIBRARIES: &[&str] = &[
    "libX11.so.6",
    "libX11-xcb.so.1",
    "libxcb.so.1",
    "libXcursor.so.1",
    "libXi.so.6",
    "libXrandr.so.2",
    "libxkbcommon-x11.so.0",
];

/// Mirrors winit's order: Wayland first, then X11. Remote X11 displays are not
/// probed because that would need the network.
pub fn session(
    env: impl Fn(&'static str) -> Option<OsString>,
    reachable: impl Fn(&Path) -> bool,
) -> (Session, Vec<Finding>) {
    let wayland = env("WAYLAND_DISPLAY").filter(|value| !value.is_empty());
    let wayland_socket = wayland.map(|display| {
        let display = PathBuf::from(display);
        match env("XDG_RUNTIME_DIR") {
            Some(runtime) if !display.is_absolute() => PathBuf::from(runtime).join(display),
            _ => display,
        }
    });
    let wayland_ok = wayland_socket.as_deref().is_some_and(&reachable);
    let x11 = env("DISPLAY").filter(|value| !value.is_empty());
    let x11_socket = x11.as_ref().and_then(local_x11_socket);
    let x11_ok = x11_socket.as_deref().is_some_and(&reachable);
    let x11_remote = x11.is_some() && x11_socket.is_none();
    let wayland_finding = match (&wayland_socket, wayland_ok) {
        (None, _) => Finding::new("wayland", Status::Note, "WAYLAND_DISPLAY is not set"),
        (Some(_), true) => Finding::new("wayland", Status::Ok, "compositor socket reachable"),
        (Some(_), false) => Finding::new(
            "wayland",
            Status::Note,
            "WAYLAND_DISPLAY is set but its socket is not reachable",
        ),
    };
    let x11_finding = match (x11.is_some(), x11_ok, x11_remote) {
        (false, _, _) => Finding::new("x11", Status::Note, "DISPLAY is not set"),
        (true, true, _) => Finding::new("x11", Status::Ok, "local X server socket reachable"),
        (true, false, true) => Finding::new(
            "x11",
            Status::Note,
            "DISPLAY names a remote or unrecognised X server; not probed",
        ),
        (true, false, false) => Finding::new(
            "x11",
            Status::Note,
            "DISPLAY is set but its local socket is not reachable",
        ),
    };
    let selected = if wayland_ok {
        Session::Wayland
    } else if x11_ok || x11_remote {
        Session::X11
    } else {
        Session::None
    };
    let session_finding = match selected {
        Session::Wayland => Finding::new("session", Status::Ok, "Maple will use Wayland"),
        Session::X11 => Finding::new("session", Status::Ok, "Maple will use X11"),
        Session::None => Finding::new(
            "session",
            Status::Problem,
            "no reachable Wayland or X11 display; start Maple from a graphical desktop session",
        ),
    };
    (
        selected,
        vec![session_finding, wayland_finding, x11_finding],
    )
}

fn local_x11_socket(display: &OsString) -> Option<PathBuf> {
    let display = display.to_str()?;
    let local = display.strip_prefix("unix").unwrap_or(display);
    let number = local.strip_prefix(':')?.split('.').next()?;
    (!number.is_empty() && number.chars().all(|digit| digit.is_ascii_digit()))
        .then(|| PathBuf::from(format!("/tmp/.X11-unix/X{number}")))
}

pub fn libraries(session: Session, loadable: impl Fn(&str) -> bool) -> Vec<Finding> {
    let required: Vec<&str> = match session {
        Session::Wayland => [BASE_LIBRARIES, WAYLAND_LIBRARIES].concat(),
        Session::X11 => [BASE_LIBRARIES, X11_LIBRARIES].concat(),
        Session::None => [BASE_LIBRARIES, WAYLAND_LIBRARIES, X11_LIBRARIES].concat(),
    };
    let (blocking, optional): (Vec<&str>, Vec<&str>) =
        [BASE_LIBRARIES, WAYLAND_LIBRARIES, X11_LIBRARIES]
            .concat()
            .into_iter()
            .filter(|library| !loadable(library))
            .partition(|library| required.contains(library));
    let blocking_finding = if blocking.is_empty() {
        Finding::new(
            "libraries",
            Status::Ok,
            "every library this session needs can be loaded",
        )
    } else {
        Finding::new(
            "libraries",
            Status::Problem,
            format!("missing: {}", blocking.join(", ")),
        )
    };
    let optional_finding = (!optional.is_empty()).then(|| {
        Finding::new(
            "libraries",
            Status::Note,
            format!(
                "not needed by this session, missing: {}",
                optional.join(", ")
            ),
        )
    });
    std::iter::once(blocking_finding)
        .chain(optional_finding)
        .collect()
}

pub fn gpu(adapter: Result<wgpu::AdapterInfo, String>) -> Vec<Finding> {
    match adapter {
        Err(error) => vec![Finding::new(
            "vulkan",
            Status::Problem,
            format!("no usable GPU adapter ({error}); install a Vulkan driver such as Mesa's"),
        )],
        Ok(info) => {
            let driver = format!("{} {}", info.driver, info.driver_info);
            let summary = format!(
                "{} ({:?}, {:?}, driver {})",
                info.name,
                info.backend,
                info.device_type,
                match driver.trim() {
                    "" => "not reported",
                    reported => reported,
                }
            );
            let adapter = if info.backend == wgpu::Backend::Vulkan {
                Finding::new("vulkan", Status::Ok, summary)
            } else {
                Finding::new(
                    "vulkan",
                    Status::Problem,
                    format!("{summary}; Maple on Linux requires a Vulkan adapter"),
                )
            };
            let software = (info.device_type == wgpu::DeviceType::Cpu).then(|| {
                Finding::new(
                    "vulkan",
                    Status::Note,
                    "software rendering: previews work but are much slower than on a GPU",
                )
            });
            std::iter::once(adapter).chain(software).collect()
        }
    }
}

#[derive(Debug)]
pub enum Portal {
    Available(u32),
    Unavailable,
    NotProbed,
}

pub fn portal(portal: Portal, zenity: bool) -> Finding {
    match (portal, zenity) {
        (Portal::Available(version), _) => Finding::new(
            "portal",
            Status::Ok,
            format!("desktop portal file chooser (version {version})"),
        ),
        (Portal::NotProbed, _) => Finding::new(
            "portal",
            Status::Note,
            "the session bus is not a local socket; not probed",
        ),
        (Portal::Unavailable, true) => Finding::new(
            "portal",
            Status::Note,
            "no desktop portal file chooser; the folder picker falls back to zenity",
        ),
        (Portal::Unavailable, false) => Finding::new(
            "portal",
            Status::Problem,
            "no desktop portal file chooser and no zenity, so the folder picker cannot open; \
             install xdg-desktop-portal with your desktop's backend",
        ),
    }
}

pub fn render(findings: &[Finding]) -> String {
    let mut report = String::from(
        "Maple diagnostics (no network access; environment values and photo paths are omitted)\n",
    );
    for finding in findings {
        let label = match finding.status {
            Status::Ok => "ok",
            Status::Note => "note",
            Status::Problem => "problem",
        };
        let _ = writeln!(report, "[{label}] {}: {}", finding.check, finding.detail);
    }
    let problems = findings
        .iter()
        .filter(|finding| finding.status == Status::Problem)
        .count();
    let _ = writeln!(report, "problems: {problems}");
    report
}

pub fn run() -> Vec<Finding> {
    let (selected, session_findings) = session(std::env::var_os, |path| {
        std::os::unix::net::UnixStream::connect(path).is_ok()
    });
    let adapter = raw_gpu::GpuContext::new_blocking().map(|context| context.adapter.get_info());
    std::iter::once(system())
        .chain(gpu(adapter))
        .chain(session_findings)
        .chain(libraries(selected, loadable))
        .chain(std::iter::once(portal(probe_portal(), on_path("zenity"))))
        .collect()
}

fn system() -> Finding {
    let release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let field = |key: &str| {
        release
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .map(|value| value.trim_matches('"'))
            .filter(|value| {
                value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
            })
            .unwrap_or("unknown")
            .to_string()
    };
    Finding::new(
        "system",
        Status::Ok,
        format!(
            "{} {} {}",
            field("ID"),
            field("VERSION_ID"),
            std::env::consts::ARCH
        ),
    )
}

fn loadable(library: &str) -> bool {
    let Ok(name) = CString::new(library) else {
        return false;
    };
    // SAFETY: dlopen receives a valid C string and the handle is closed once.
    unsafe {
        let handle = libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        !handle.is_null() && libc::dlclose(handle) == 0
    }
}

fn on_path(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| {
            std::fs::metadata(directory.join(program)).is_ok_and(|metadata| {
                use std::os::unix::fs::PermissionsExt;
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
    })
}

fn probe_portal() -> Portal {
    let local_bus = std::env::var_os("DBUS_SESSION_BUS_ADDRESS")
        .is_none_or(|address| address.to_string_lossy().starts_with("unix:"));
    if !local_bus {
        return Portal::NotProbed;
    }
    let version = zbus::blocking::connection::Builder::session()
        .map(|builder| builder.method_timeout(Duration::from_secs(10)))
        .and_then(|builder| builder.build())
        .and_then(|connection| {
            zbus::blocking::Proxy::new(
                &connection,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.FileChooser",
            )?
            .get_property::<u32>("version")
        });
    version.map_or(Portal::Unavailable, Portal::Available)
}
