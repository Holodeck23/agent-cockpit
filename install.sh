#!/bin/sh
# Install or update Cockpit from its GitHub releases:
#   curl -fsSL https://raw.githubusercontent.com/Holodeck23/agent-cockpit/main/install.sh | sh
#
# Cockpit is not notarized. A DMG downloaded in a browser is quarantined, and macOS then
# blocks the first launch ("Cockpit Not Opened"). curl does not quarantine what it downloads,
# so the app installed here opens normally. The DMG is checked against the release's
# SHA256SUMS before anything is copied.
#
# COCKPIT_VERSION=v0.1.5 installs that release instead of the newest.
# COCKPIT_INSTALL_DIR=<dir> installs somewhere other than /Applications.
set -eu

REPO=Holodeck23/agent-cockpit
DEST=${COCKPIT_INSTALL_DIR:-/Applications}

say() { printf '%s\n' "$*"; }
fail() { printf 'Cockpit install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "Cockpit is a macOS app."
[ "$(uname -m)" = arm64 ] || fail "Cockpit is built for Apple-silicon Macs only."
pgrep -f "$DEST/Cockpit.app/Contents/MacOS/" >/dev/null && fail "Cockpit is running. Quit it (Cockpit > Quit Cockpit), then run this again. Your conversations and settings are kept."

# Releases are pre-releases, so /releases/latest does not name one: the newest from the API.
tag=${COCKPIT_VERSION:-$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=1" \
  | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)}
[ -n "$tag" ] || fail "could not find a release on github.com/$REPO."
dmg="Cockpit-${tag#v}-arm64.dmg"
base="https://github.com/$REPO/releases/download/$tag"

work=$(mktemp -d)
mount="$work/mount"
cleanup() {
  [ -d "$mount" ] && hdiutil detach -quiet "$mount" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

say "Downloading Cockpit ${tag}..."
curl -fL --progress-bar -o "$work/$dmg" "$base/$dmg" || fail "download failed: $base/$dmg"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download SHA256SUMS for $tag."
expected=$(awk -v f="$dmg" '$2 == f { print $1 }' "$work/SHA256SUMS")
actual=$(shasum -a 256 "$work/$dmg" | awk '{ print $1 }')
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch for $dmg: nothing was installed."

mkdir -p "$mount"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$work/$dmg" || fail "could not open $dmg."
[ -d "$mount/Cockpit.app" ] || fail "$dmg has no Cockpit.app."
mkdir -p "$DEST" || fail "cannot write to $DEST."

# The old app is kept aside until the new one is in place, and put back if copying fails.
if [ -d "$DEST/Cockpit.app" ]; then
  mv "$DEST/Cockpit.app" "$work/Cockpit.app.previous" || fail "cannot replace $DEST/Cockpit.app."
fi
if ! ditto "$mount/Cockpit.app" "$DEST/Cockpit.app"; then
  rm -rf "$DEST/Cockpit.app"
  [ -d "$work/Cockpit.app.previous" ] && mv "$work/Cockpit.app.previous" "$DEST/Cockpit.app"
  fail "copying to $DEST failed; the previous Cockpit was left as it was."
fi

say "Cockpit $tag is in $DEST. Open it from there, or run: open \"$DEST/Cockpit.app\""
