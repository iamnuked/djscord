#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
app_directory="$project_root/macos-app/build/djscord Studio.app"
architecture="$(uname -m)"
iconset_directory="$project_root/macos-app/build/AppIcon.iconset"
mkdir -p "$app_directory/Contents/MacOS" "$app_directory/Contents/Resources"
# Local artwork is not distributed by default, even when left over from an earlier build.
rm -f "$app_directory/Contents/Resources/AppIcon.icns"
cp "$project_root/macos-app/Info.plist" "$app_directory/Contents/Info.plist"
if [ "${DJSCORD_INCLUDE_LOCAL_ARTWORK:-0}" = "1" ]; then
  mkdir -p "$iconset_directory"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$project_root/macos-app/Assets/AppIcon.png" \
      --out "$iconset_directory/icon_${size}x${size}.png" >/dev/null
    retina_size=$((size * 2))
    sips -z "$retina_size" "$retina_size" "$project_root/macos-app/Assets/AppIcon.png" \
      --out "$iconset_directory/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset_directory" -o "$app_directory/Contents/Resources/AppIcon.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon.icns" "$app_directory/Contents/Info.plist"
fi
cp "$project_root/LICENSE" "$app_directory/Contents/Resources/LICENSE.txt"
cp "$project_root/THIRD_PARTY_NOTICES.md" "$app_directory/Contents/Resources/THIRD_PARTY_NOTICES.md"
cp -R "$project_root/licenses" "$app_directory/Contents/Resources/"
/usr/libexec/PlistBuddy -c "Add :DjscordProjectPath string $project_root" "$app_directory/Contents/Info.plist"
swiftc -parse-as-library -O -target "$architecture-apple-macos14.2" \
  "$project_root/macos-system-audio-capture.swift" \
  -o "$app_directory/Contents/Resources/djscord-system-audio" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
  -Xlinker "$project_root/macos-system-audio-info.plist"
swiftc -parse-as-library -O -target "$architecture-apple-macos14.2" \
  -D DJSCORD_LIBRARY \
  "$project_root/macos-system-audio-capture.swift" \
  "$project_root/macos-app/AudioAppMixer.swift" \
  "$project_root/macos-app/DjscordApp.swift" \
  -o "$app_directory/Contents/MacOS/DjscordStudio"
codesign --force --sign - "$app_directory/Contents/Resources/djscord-system-audio"
codesign --force --sign - "$app_directory"
printf '앱 생성 완료: %s\n' "$app_directory"
