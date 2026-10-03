"""Owned SMB test relay: drop one successful rename acknowledgement (#4065)."""

import argparse
import json
import socket
import struct
import threading
from pathlib import Path


def packets(data):
    offset = 0
    while data[offset : offset + 4] == b"\xfeSMB":
        if len(data) < offset + 64:
            return
        command = struct.unpack_from("<H", data, offset + 12)[0]
        status = struct.unpack_from("<I", data, offset + 8)[0]
        message = struct.unpack_from("<Q", data, offset + 24)[0]
        yield offset, command, status, message
        following = struct.unpack_from("<I", data, offset + 20)[0]
        if following == 0:
            return
        offset += following


def receive(stream, count):
    result = bytearray()
    while len(result) < count:
        chunk = stream.recv(count - len(result))
        if not chunk:
            raise EOFError
        result.extend(chunk)
    return bytes(result)


def relay(client, target_port, directory):
    server = socket.create_connection(("127.0.0.1", target_port), timeout=10)
    server.settimeout(None)
    renames = set()
    lock = threading.Lock()

    def forward(source, destination, response):
        try:
            while True:
                header = receive(source, 4)
                data = receive(source, int.from_bytes(header[1:], "big"))
                for offset, command, status, message in packets(data):
                    if command != 17:
                        continue
                    if not response:
                        if len(data) > offset + 67 and data[offset + 67] == 10:
                            with lock:
                                renames.add(message)
                    else:
                        with lock:
                            rename = message in renames
                            renames.discard(message)
                        armed = directory / "drop-next-rename"
                        if rename and status == 0 and armed.exists():
                            armed.unlink()
                            (directory / "dropped-rename").write_text(str(message))
                            return
                destination.sendall(header + data)
        except (EOFError, OSError):
            return
        finally:
            for stream in (client, server):
                try:
                    stream.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                stream.close()

    upstream = threading.Thread(
        target=forward, args=(client, server, False), daemon=True
    )
    upstream.start()
    forward(server, client, True)
    upstream.join(timeout=2)


parser = argparse.ArgumentParser()
parser.add_argument("--target-port", type=int, required=True)
parser.add_argument("--directory", type=Path, required=True)
args = parser.parse_args()
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    (args.directory / "proxy.json").write_text(
        json.dumps({"port": listener.getsockname()[1]})
    )
    while True:
        client, _ = listener.accept()
        threading.Thread(
            target=relay, args=(client, args.target_port, args.directory), daemon=True
        ).start()
