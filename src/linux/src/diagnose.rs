//! `maple-linux --diagnose`: a read-only installation report. It never starts
//! the window, never uses the network and prints no environment values or paths.

use eframe::egui_wgpu::wgpu;
use std::ffi::{CString, OsString};
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
    "libxkbcommon-x11.so.0",
];

enum X11Display {
    Local(PathBuf),
    Remote,
    Invalid,
}

/// Mirrors winit 0.30: a configured Wayland display is used without falling
/// back to X11. Remote X11 displays are not probed because that needs the network.
pub fn session(
    env: impl Fn(&'static str) -> Option<OsString>,
    reachable: impl Fn(&Path) -> bool,
) -> (Session, Finding) {
    let set = |name| env(name).filter(|value| !value.is_empty());
    let problem = |detail| Finding::new("session", Status::Problem, detail);
    if set("WAYLAND_SOCKET").is_some() {
        return (
            Session::Wayland,
            Finding::new(
                "session",
                Status::Ok,
                "Wayland (inherited compositor socket)",
            ),
        );
    }
    if let Some(display) = set("WAYLAND_DISPLAY") {
        let display = PathBuf::from(display);
        let socket = match set("XDG_RUNTIME_DIR") {
            Some(runtime) if !display.is_absolute() => PathBuf::from(runtime).join(display),
            _ => display,
        };
        return (
            Session::Wayland,
            if reachable(&socket) {
                Finding::new(
                    "session",
                    Status::Ok,
                    "Wayland (compositor socket reachable)",
                )
            } else {
                problem(
                    "WAYLAND_DISPLAY is set but its socket is not reachable; \
                     Maple does not fall back to X11 while it is set",
                )
            },
        );
    }
    match set("DISPLAY").map(|display| x11_display(&display)) {
        None => (
            Session::None,
            problem("no Wayland or X11 display; start Maple from a graphical desktop session"),
        ),
        Some(X11Display::Invalid) => (Session::None, problem("DISPLAY is not a valid X11 display")),
        Some(X11Display::Remote) => (
            Session::X11,
            Finding::new("session", Status::Ok, "X11 (remote display; not probed)"),
        ),
        Some(X11Display::Local(socket)) => (
            Session::X11,
            if reachable(&socket) {
                Finding::new(
                    "session",
                    Status::Ok,
                    "X11 (local X server socket reachable)",
                )
            } else {
                problem("DISPLAY is set but its local X server socket is not reachable")
            },
        ),
    }
}

fn x11_display(display: &OsString) -> X11Display {
    let parsed = display.to_str().and_then(|display| {
        let (host, rest) = display.rsplit_once(':')?;
        let number = rest.split('.').next()?;
        (!number.is_empty() && number.chars().all(|digit| digit.is_ascii_digit()))
            .then_some((host, number))
    });
    match parsed {
        None => X11Display::Invalid,
        Some(("" | "unix", number)) => {
            X11Display::Local(PathBuf::from(format!("/tmp/.X11-unix/X{number}")))
        }
        Some(_) => X11Display::Remote,
    }
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
    Activatable,
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
        (Portal::Activatable, _) => Finding::new(
            "portal",
            Status::Ok,
            "desktop portal installed; D-Bus starts it when the folder picker opens",
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
    let label = |status| match status {
        Status::Ok => "ok",
        Status::Note => "note",
        Status::Problem => "problem",
    };
    let problems = findings
        .iter()
        .filter(|finding| finding.status == Status::Problem)
        .count();
    std::iter::once(
        "Maple diagnostics (no network access; environment values and photo paths are omitted)"
            .to_string(),
    )
    .chain(findings.iter().map(|finding| {
        format!(
            "[{}] {}: {}",
            label(finding.status),
            finding.check,
            finding.detail
        )
    }))
    .chain(std::iter::once(format!("problems: {problems}")))
    .map(|line| line + "\n")
    .collect()
}

pub fn run() -> Vec<Finding> {
    let (selected, session_finding) = session(std::env::var_os, |path| {
        std::os::unix::net::UnixStream::connect(path).is_ok()
    });
    let adapter = raw_gpu::GpuContext::new_blocking().map(|context| context.adapter.get_info());
    std::iter::once(system())
        .chain(gpu(adapter))
        .chain(std::iter::once(session_finding))
        .chain(libraries(selected, loadable))
        .chain(std::iter::once(portal(probe_portal(), on_path("zenity"))))
        .collect()
}

fn system() -> Finding {
    system_from(&std::fs::read_to_string("/etc/os-release").unwrap_or_default())
}

/// Only plain identifier characters from os-release reach the report.
pub fn system_from(release: &str) -> Finding {
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

const PORTAL: &str = "org.freedesktop.portal.Desktop";

/// Never auto-starts the portal: an inactive one is only reported as activatable.
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
            let bus = zbus::blocking::fdo::DBusProxy::new(&connection)?;
            if !bus.name_has_owner(zbus::names::BusName::try_from(PORTAL)?)? {
                let activatable = bus
                    .list_activatable_names()?
                    .iter()
                    .any(|name| name.as_str() == PORTAL);
                return Ok(activatable.then_some(None));
            }
            let version = zbus::blocking::Proxy::new(
                &connection,
                PORTAL,
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.FileChooser",
            )?
            .get_property::<u32>("version")?;
            Ok(Some(Some(version)))
        });
    match version {
        Ok(Some(Some(version))) => Portal::Available(version),
        Ok(Some(None)) => Portal::Activatable,
        _ => Portal::Unavailable,
    }
}
