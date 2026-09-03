@echo off
rem maple — shim so the Maple CLI is invocable as `maple` from any shell.
rem Installed to {app}\bin (the only directory the installer puts on PATH);
rem the real binary ships beside the app as maple-cli.exe, where
rem PanoProvisioner also expects it.
"%~dp0..\maple-cli.exe" %*
