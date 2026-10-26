#!/usr/bin/env bash
# Per-user install, update and removal of the Maple AppImage with desktop
# integration. The AppImage is extracted, so FUSE and root are not needed.
set -euo pipefail

app_id=app.justmaple.aperture
usage="Usage: $0 Maple-<version>-x86_64.AppImage | --uninstall"

if [[ $# -ne 1 ]]; then
	echo "$usage" >&2
	exit 2
fi
if [[ $1 == --uninstall ]]; then
	operation=uninstall
elif [[ -f $1 ]]; then
	operation=install
	appimage=$(realpath -- "$1")
else
	echo "$usage" >&2
	exit 2
fi

home=${HOME:?HOME is required}
data_home=${XDG_DATA_HOME:-$home/.local/share}
for location in "$home" "$data_home"; do
	if [[ $location != /* || $location == *$'\n'* || $location == *$'\r'* ]]; then
		echo "HOME and XDG_DATA_HOME must be absolute paths without line breaks." >&2
		exit 2
	fi
done
install_root=$home/.local/opt
target=$install_root/maple-appimage
marker=.maple-appimage-install
desktop=$data_home/applications/$app_id.desktop
icon=$data_home/icons/hicolor/512x512/apps/$app_id.png
mime=$data_home/mime/packages/$app_id.xml

mkdir -p -- "$install_root"
exec 9>"$install_root/.maple-appimage.lock"
if ! flock -n 9; then
	echo "Another Maple installation or removal is running; retry when it finishes." >&2
	exit 1
fi

if [[ $operation == uninstall && ! -e $target && ! -L $target ]]; then
	echo "Maple's AppImage is not installed in $target"
	exit 0
fi
if [[ -L $target || (-e $target && ! -f $target/$marker) ]]; then
	echo "Refusing to change $target: it was not created by this installer." >&2
	exit 1
fi

# Desktop entry Exec quoting: escape for the quoted argument, then for the
# entry's own string escapes.
quote_exec() {
	local value=$1 tick='`'
	value=${value//\\/\\\\}
	value=${value//\"/\\\"}
	value=${value//\$/\\\$}
	value=${value//$tick/\\$tick}
	value=${value//%/%%}
	value=${value//\\/\\\\}
	printf '"%s"' "$value"
}

refresh() {
	local stale=0
	if command -v update-mime-database >/dev/null && [[ -d $data_home/mime/packages ]]; then
		update-mime-database "$data_home/mime" || stale=1
	fi
	if command -v update-desktop-database >/dev/null && [[ -d $data_home/applications ]]; then
		update-desktop-database "$data_home/applications" || stale=1
	fi
	if [[ $stale -ne 0 ]]; then
		echo "Desktop caches could not be refreshed; sign out and back in to update file associations." >&2
	fi
}

# Remove an integration file only if it is still the copy this installer wrote.
remove_owned() {
	local installed=$1 original=$2
	if [[ -f $installed && ! -L $installed ]] && cmp -s -- "$installed" "$original"; then
		rm -- "$installed"
	elif [[ -e $installed || -L $installed ]]; then
		echo "Keeping $installed: it was changed after installation." >&2
	fi
}

publish() {
	local source=$1 destination=$2 staged
	mkdir -p -- "$(dirname -- "$destination")"
	if [[ -d $destination && ! -L $destination ]]; then
		echo "Refusing to replace the directory $destination" >&2
		return 1
	fi
	staged=$(mktemp "$(dirname -- "$destination")/.maple.XXXXXXXX")
	cp -- "$source" "$staged"
	chmod 644 -- "$staged"
	mv -fT -- "$staged" "$destination"
}

if [[ $operation == uninstall ]]; then
	remove_owned "$desktop" "$target/$marker.desktop"
	remove_owned "$icon" "$target/usr/share/icons/hicolor/512x512/apps/$app_id.png"
	remove_owned "$mime" "$target/usr/share/mime/packages/$app_id.xml"
	rm -rf -- "$target"
	refresh
	echo "Removed Maple's AppImage installation. Photos and XMP sidecars were not touched."
	exit 0
fi

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
	echo "This AppImage requires 64-bit x86 Linux." >&2
	exit 1
fi

work=$(mktemp -d "$install_root/.maple-appimage.XXXXXXXX")
integration=("$icon" "$mime" "$desktop")
swapped=0
committed=0
# Until every file is published, a failure or interrupt restores the previous
# application and integration files.
cleanup() {
	local status=$? index
	trap - EXIT
	if [[ $swapped -eq 1 && $committed -eq 0 ]]; then
		for index in "${!integration[@]}"; do
			if [[ -e $work/integration-$index || -L $work/integration-$index ]]; then
				mv -fT -- "$work/integration-$index" "${integration[index]}"
			else
				rm -f -- "${integration[index]}"
			fi
		done
		rm -rf -- "$target"
		if [[ -e $work/previous ]]; then
			mv -- "$work/previous" "$target"
		fi
		echo "Installation failed; the previous state was restored." >&2
	fi
	rm -rf -- "$work"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -- "$appimage" "$work/Maple.AppImage"
chmod u+x -- "$work/Maple.AppImage"
if ! (cd -- "$work" && ./Maple.AppImage --appimage-extract >/dev/null); then
	echo "Could not extract $appimage; download it again and check its .sha256 file." >&2
	exit 1
fi
extracted=$work/squashfs-root
binary=$target/usr/bin/maple-linux
for required in install-maple-appimage.sh usr/bin/maple-linux "usr/share/applications/$app_id.desktop" \
	"usr/share/icons/hicolor/512x512/apps/$app_id.png" "usr/share/mime/packages/$app_id.xml"; do
	if [[ ! -f $extracted/$required || -L $extracted/$required ]]; then
		echo "The AppImage is missing $required" >&2
		exit 1
	fi
done

while IFS= read -r line; do
	case $line in
	Exec=*) printf 'Exec=%s %%f\n' "$(quote_exec "$binary")" ;;
	TryExec=*) ;;
	*) printf '%s\n' "$line" ;;
	esac
done <"$extracted/usr/share/applications/$app_id.desktop" >"$extracted/$marker.desktop"
chmod 755 -- "$extracted/install-maple-appimage.sh"
: >"$extracted/$marker"

for index in "${!integration[@]}"; do
	if [[ -e ${integration[index]} || -L ${integration[index]} ]]; then
		cp -a -- "${integration[index]}" "$work/integration-$index"
	fi
done
if [[ -e $target ]]; then
	mv -- "$target" "$work/previous"
fi
swapped=1
mv -- "$extracted" "$target"
publish "$target/usr/share/icons/hicolor/512x512/apps/$app_id.png" "$icon"
publish "$target/usr/share/mime/packages/$app_id.xml" "$mime"
publish "$target/$marker.desktop" "$desktop"
committed=1
refresh
echo "Installed Maple in $target"
echo "Open Maple from your application menu, or use Open With on a photo."
echo "Remove it with: $target/install-maple-appimage.sh --uninstall"
