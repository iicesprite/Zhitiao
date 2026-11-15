#!/bin/bash
set -euo pipefail

if [[ "$(/usr/bin/uname -s)" != "Darwin" || "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" != "1" ]]; then
  printf '%s\n' '请在 Apple 芯片 Mac 上打开安装程序。' >&2
  exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
archive="$here/electron-mac-arm64.zip"
dest="$HOME/Applications"
target="$dest/纸条桌宠.app"
if [[ ! -f "$archive" || ! -f "$here/app/package.json" || ! -f "$here/app-version.txt" ]]; then
  printf '%s\n' '请解压整个安装包，并从解压后的文件夹运行脚本。' >&2
  exit 1
fi
read -r version < "$here/app-version.txt"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf '%s\n' '安装包的版本信息不完整。' >&2
  exit 1
fi
if [[ -e "$target" || -L "$target" ]]; then
  existing_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$target/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -L "$target" || "$existing_id" != 'local.zhitiao.desktop' ]]; then
    printf '%s\n' "安装位置已被占用：$target" >&2
    exit 1
  fi
  existing_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$target/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$existing_version" == "$version" ]]; then
    /usr/bin/open "$target"
    exit 0
  fi
fi

expected='8bdf5d55fbcc2c348b5d34b9e87a364cd2947d00b7c8bfadc6cc50233cd79ac6'
checksum="$(/usr/bin/shasum -a 256 "$archive")"
if [[ "${checksum%% *}" != "$expected" ]]; then
  printf '%s\n' '安装包校验失败，请重新获取完整的安装包。' >&2
  exit 1
fi

/bin/mkdir -p "$dest"
stage="$(/usr/bin/mktemp -d "$dest/.zhitiao.XXXXXXXX")"
cleanup() {
  if [[ -e "$stage/previous.app" && ! -e "$target" ]]; then
    /bin/mv "$stage/previous.app" "$target" || return
  fi
  /bin/rm -rf -- "$stage"
}
trap cleanup EXIT
/usr/bin/ditto -x -k "$archive" "$stage"
bundle="$stage/Electron.app"
resources="$bundle/Contents/Resources"
/usr/bin/ditto "$here/app" "$resources/app"
/bin/cp "$here/app/desktop/ui/icon.icns" "$resources/Zhitiao.icns"
plist="$bundle/Contents/Info.plist"

set_plist() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist"
}
set_plist CFBundleName '纸条桌宠'
set_plist CFBundleDisplayName '纸条桌宠'
set_plist CFBundleIdentifier local.zhitiao.desktop
set_plist CFBundleIconFile Zhitiao.icns
set_plist CFBundleShortVersionString "$version"
set_plist CFBundleVersion "$version"

/usr/bin/codesign --force --deep --sign - "$bundle"
/usr/bin/codesign --verify --deep --strict "$bundle"
if [[ -e "$target" ]]; then /bin/mv "$target" "$stage/previous.app"; fi
/bin/mv "$bundle" "$target"
printf '%s\n' '纸条桌宠安装完成。以后可用聚焦搜索打开「纸条桌宠」。'
/usr/bin/open "$target"
