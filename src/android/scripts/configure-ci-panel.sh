#!/usr/bin/env bash
# #4984: boot the AVD with the tested 1280x800 mdpi panel. A runtime
# `wm size`/`wm density` override on the 2560x1600 pixel_tablet panel makes
# SurfaceFlinger client-compose and scale every frame in software, which
# starved SystemUI's first-boot services into ANRs on the 2-core emulator.
set -euo pipefail
config="${ANDROID_AVD_HOME:-$HOME/.android/avd}/${1:?Pass the AVD name}.avd/config.ini"
test -w "$config"
sed -i -E '/^hw\.lcd\.(width|height|density)[[:space:]]*=/d' "$config"
printf 'hw.lcd.width=1280\nhw.lcd.height=800\nhw.lcd.density=160\n' >>"$config"
