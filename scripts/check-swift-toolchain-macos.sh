#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PACKAGE_PATH="${1:-apps/macos}"
REQUIRED_TOOLS_VERSION="${OPENCLAW_REQUIRED_SWIFT_TOOLS_VERSION:-6.2}"
REQUIRED_XCODE_MAJOR="${OPENCLAW_REQUIRED_XCODE_MAJOR:-26}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

manifest_path="$ROOT_DIR/$PACKAGE_PATH/Package.swift"
if [[ ! -f "$manifest_path" ]]; then
  echo "error: Package manifest not found at $manifest_path" >&2
  exit 1
fi

manifest_tools_version="$({ sed -n '1s#// swift-tools-version: *##p' "$manifest_path" || true; } | tr -d '[:space:]')"
if [[ -n "$manifest_tools_version" ]]; then
  REQUIRED_TOOLS_VERSION="$manifest_tools_version"
fi

active_dev_dir="$(xcode-select -p 2>/dev/null || true)"
if [[ -z "$active_dev_dir" ]]; then
  cat >&2 <<EOF
error: macOS Swift checks require Xcode ${REQUIRED_XCODE_MAJOR}+ with Swift tools ${REQUIRED_TOOLS_VERSION}.
No active developer directory is selected.

Fix:
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
EOF
  exit 1
fi

if [[ "$active_dev_dir" == "/Library/Developer/CommandLineTools" ]]; then
  cat >&2 <<EOF
error: macOS Swift checks require full Xcode ${REQUIRED_XCODE_MAJOR}+ with Swift tools ${REQUIRED_TOOLS_VERSION}.
Active developer directory is Command Line Tools only:
  $active_dev_dir

Fix:
  1. Install Xcode ${REQUIRED_XCODE_MAJOR}+ (or newer) in /Applications
  2. sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
EOF
  exit 1
fi

swift_version_line="$(swift --version 2>/dev/null | head -n 1 || true)"
if [[ -z "$swift_version_line" ]]; then
  echo "error: unable to determine swift version from active developer directory: $active_dev_dir" >&2
  exit 1
fi

actual_swift_version="$(printf '%s\n' "$swift_version_line" | sed -n 's/.*Apple Swift version \([0-9][0-9.]*\).*/\1/p')"
if [[ -z "$actual_swift_version" ]]; then
  actual_swift_version="$(printf '%s\n' "$swift_version_line" | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1 || true)"
fi

actual_swift_major_minor="$(printf '%s\n' "$actual_swift_version" | awk -F. '{print $1 "." $2}')"
required_swift_major_minor="$(printf '%s\n' "$REQUIRED_TOOLS_VERSION" | awk -F. '{print $1 "." $2}')"

if [[ "$actual_swift_major_minor" != "$required_swift_major_minor" ]]; then
  cat >&2 <<EOF
error: macOS Swift checks require Swift tools ${REQUIRED_TOOLS_VERSION}, but active swift is ${actual_swift_version:-unknown}.
Active developer directory:
  $active_dev_dir

Fix:
  Install/select Xcode ${REQUIRED_XCODE_MAJOR}+ that provides Swift ${REQUIRED_TOOLS_VERSION}.
  Then run:
    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
EOF
  exit 1
fi

xcode_version_line="$(xcodebuild -version 2>/dev/null | head -n 1 || true)"
if [[ -n "$xcode_version_line" ]]; then
  xcode_major="$(printf '%s\n' "$xcode_version_line" | awk '{print $2}' | awk -F. '{print $1}')"
  if [[ -n "$xcode_major" ]] && [[ "$xcode_major" -lt "$REQUIRED_XCODE_MAJOR" ]]; then
    cat >&2 <<EOF
error: macOS Swift checks require Xcode ${REQUIRED_XCODE_MAJOR}+ for Swift tools ${REQUIRED_TOOLS_VERSION}, but active Xcode is:
  $xcode_version_line

Fix:
  Install/select Xcode ${REQUIRED_XCODE_MAJOR}+ and re-run.
EOF
    exit 1
  fi
fi

echo "ok: macOS Swift toolchain ${actual_swift_version} via ${active_dev_dir}" >&2
