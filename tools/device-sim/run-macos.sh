#!/usr/bin/env bash
set -euo pipefail

sim_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'The BLE simulator requires macOS.\n' >&2
    exit 1
fi

swift build --package-path "$sim_dir" --product pathnod-device-sim
bin_dir="$(swift build --package-path "$sim_dir" --show-bin-path)"
app_dir="$sim_dir/.build/PathnodDeviceSimulator.app"
mkdir -p "$app_dir/Contents/MacOS"
cp "$sim_dir/macOS/Info.plist" "$app_dir/Contents/Info.plist"
cp "$bin_dir/pathnod-device-sim" "$app_dir/Contents/MacOS/pathnod-device-sim"

# Local ad-hoc signing gives TCC a stable app identity; no Apple Developer account is needed.
codesign --force --sign - --timestamp=none "$app_dir"
open -n -a "$app_dir" --args "$@"
printf 'PathnodDeviceSimulator launched. View logs in Console.app (filter: xyz.pathnod.device-sim).\n'
printf 'Quit the app in Activity Monitor when the BLE test is finished.\n'
