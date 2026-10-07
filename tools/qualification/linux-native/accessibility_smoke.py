#!/usr/bin/env python3
"""Check real Maple AT-SPI browse/edit/undo on a live Wayland session (#4317).

Requires dbus-python. Temporarily enables accessibility and restores its prior
setting. Only the owned Maple process and a private synthetic fixture are used.
"""

import argparse
import os
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import dbus

ACCESSIBLE = "org.a11y.atspi.Accessible"
PROPERTIES = "org.freedesktop.DBus.Properties"
ACTION = "org.a11y.atspi.Action"
VALUE = "org.a11y.atspi.Value"


def wait_for(check, process):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Maple exited with {process.returncode}")
        try:
            result = check()
        except dbus.DBusException as error:
            # A frame may replace a loading thumbnail between tree reads.
            if error.get_dbus_name() != "org.freedesktop.DBus.Error.UnknownObject":
                raise
            result = None
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError("Accessibility check timed out")


def exposure_value(path):
    if not path.exists():
        return None
    for element in ET.fromstring(path.read_bytes()).iter():
        value = element.attrib.get(
            "{http://ns.adobe.com/camera-raw-settings/1.0/}Exposure2012"
        )
        if value is not None:
            return float(value)
    # Maple's canonical sidecar omits default-valued develop fields.
    return 0.0


def inspect(binary):
    if not os.environ.get("WAYLAND_DISPLAY"):
        raise RuntimeError("This check requires a live Wayland desktop session")
    fixture = Path(__file__).resolve().parents[3] / (
        "src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"
    )
    original_bytes = fixture.read_bytes()
    session = dbus.SessionBus()
    status = dbus.Interface(
        session.get_object("org.a11y.Bus", "/org/a11y/bus"), PROPERTIES
    )
    original_enabled = status.Get("org.a11y.Status", "IsEnabled")
    process = None
    try:
        status.Set("org.a11y.Status", "IsEnabled", dbus.Boolean(True))
        address = dbus.Interface(
            session.get_object("org.a11y.Bus", "/org/a11y/bus"), "org.a11y.Bus"
        ).GetAddress()
        bus = dbus.bus.BusConnection(str(address))
        daemon = dbus.Interface(
            bus.get_object("org.freedesktop.DBus", "/org/freedesktop/DBus"),
            "org.freedesktop.DBus",
        )
        registry = dbus.Interface(
            bus.get_object(
                "org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root"
            ),
            ACCESSIBLE,
        )
        with tempfile.TemporaryDirectory(
            prefix="maple-accessibility-smoke-"
        ) as directory:
            root = Path(directory)
            photos = root / "photos"
            photos.mkdir()
            photo = photos / "grey.dng"
            photo.write_bytes(original_bytes)
            environment = os.environ.copy()
            environment.pop("DISPLAY", None)
            with (root / "launch.log").open("w+") as log:
                process = subprocess.Popen(
                    [str(binary), str(photos)],
                    cwd=root,
                    env=environment,
                    stdout=log,
                    stderr=log,
                )

                def own_application():
                    for name, path in registry.GetChildren():
                        try:
                            if (
                                int(daemon.GetConnectionUnixProcessID(name))
                                == process.pid
                            ):
                                return str(name), str(path)
                        except dbus.DBusException:
                            continue
                    return None

                name, app_path = wait_for(own_application, process)

                def nodes():
                    records = []
                    seen = set()

                    def walk(path):
                        if path in seen:
                            return
                        seen.add(path)
                        obj = bus.get_object(name, path, introspect=False)
                        accessible = dbus.Interface(obj, ACCESSIBLE)
                        properties = dbus.Interface(obj, PROPERTIES)
                        records.append(
                            {
                                "object": obj,
                                "name": str(properties.Get(ACCESSIBLE, "Name")),
                                "role": int(accessible.GetRole()),
                                "interfaces": [
                                    str(v) for v in accessible.GetInterfaces()
                                ],
                            }
                        )
                        for child_name, child_path in accessible.GetChildren():
                            if str(child_name) != name:
                                raise RuntimeError(
                                    "Maple tree references another application"
                                )
                            walk(str(child_path))

                    walk(app_path)
                    return records

                def named(label, interface, role=None):
                    return next(
                        (
                            node["object"]
                            for node in nodes()
                            if node["name"] == label
                            and interface in node["interfaces"]
                            and (role is None or node["role"] == role)
                        ),
                        None,
                    )

                def click(label):
                    def invoke():
                        obj = named(label, ACTION)
                        if obj is None:
                            return False
                        actions = dbus.Interface(obj, ACTION)
                        for index, action in enumerate(actions.GetActions()):
                            if str(action[0]) == "click":
                                return bool(actions.DoAction(index))
                        raise RuntimeError(f"No click action for {label}")

                    wait_for(invoke, process)

                try:
                    # AT-SPI role 23 is Frame; role 51 is Slider (52 is SpinButton).
                    wait_for(lambda: named("Maple", ACCESSIBLE, 23), process)
                    click("Open grey.dng")
                    click("Light")
                    slider = wait_for(lambda: named("Exposure", VALUE, 51), process)
                    properties = dbus.Interface(slider, PROPERTIES)
                    if float(properties.Get(VALUE, "CurrentValue")) != 0.0:
                        raise RuntimeError("Unexpected initial exposure")
                    properties.Set(
                        VALUE, "CurrentValue", dbus.Double(0.75, variant_level=1)
                    )
                    sidecar = photo.with_suffix(".xmp")
                    wait_for(lambda: exposure_value(sidecar) == 0.75, process)
                    click("Undo")
                    wait_for(lambda: exposure_value(sidecar) == 0.0, process)
                    if photo.read_bytes() != original_bytes:
                        raise RuntimeError("Original RAW was modified")
                    print(
                        "AT-SPI named thumbnail open, Exposure autosave and Undo autosave pass."
                    )
                    print("Original RAW bytes unchanged; Wayland DISPLAY is unset.")
                except Exception:
                    log.seek(0)
                    print(log.read())
                    raise
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
    finally:
        try:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        finally:
            status.Set("org.a11y.Status", "IsEnabled", original_enabled)
            print(f"Desktop accessibility restored to {bool(original_enabled)}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    inspect(parser.parse_args().binary.resolve(strict=True))


if __name__ == "__main__":
    main()
