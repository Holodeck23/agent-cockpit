#!/bin/sh
# Install or update Cockpit from its GitHub releases:
#   curl -fsSL https://raw.githubusercontent.com/Holodeck23/agent-cockpit/main/install.sh | sh
#
# Cockpit is not notarized. A DMG downloaded in a browser is quarantined, and macOS then
# blocks the first launch ("Cockpit Not Opened"). curl does not quarantine what it downloads,
# so the app installed here opens normally. The DMG is checked against the release's
# SHA256SUMS before anything is copied.
#
# Installing means accepting the beta terms (BETA-TERMS.md): crash and error reports are sent, with
# no switch to turn them off. They are shown and must be accepted by typing "agree"; the acceptance
# is stored with Cockpit's state, so the app does not ask again.
#
# COCKPIT_VERSION=v0.1.5 installs that release instead of the newest.
# COCKPIT_INSTALL_DIR=<dir> installs somewhere other than /Applications.
# COCKPIT_ACCEPT_BETA_TERMS=agree accepts the terms without the prompt (no terminal to type in).
set -eu

REPO=Holodeck23/agent-cockpit
DEST=${COCKPIT_INSTALL_DIR:-/Applications}
# Same version and file as electron/telemetry-choice.ts (BETA_TERMS_VERSION) and server defaultRoot().
TERMS_VERSION=1
TERMS_FILE="${COCKPIT_HOME:-$HOME/.agent-cockpit}/beta-terms.json"

say() { printf '%s\n' "$*"; }
fail() { printf 'Cockpit install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "Cockpit is a macOS app."
[ "$(uname -m)" = arm64 ] || fail "Cockpit is built for Apple-silicon Macs only."
pgrep -f "$DEST/Cockpit.app/Contents/MacOS/" >/dev/null && fail "Cockpit is running. Quit it (Cockpit > Quit Cockpit), then run this again. Your conversations and settings are kept."

accepted=$(sed -n 's/.*"version": *\([0-9][0-9]*\).*/\1/p' "$TERMS_FILE" 2>/dev/null | head -n 1)
record_terms=
if [ "${accepted:-0}" -lt "$TERMS_VERSION" ]; then
  cat <<'TERMS'

Cockpit beta terms
------------------
Cockpit is in beta. Using it means you agree to send crash and error reports to its
developer, so problems get found and fixed. They cannot be turned off during the beta;
to stop them, stop using Cockpit.

  - A report holds the error message and stack trace, Cockpit's version, and the
    macOS version and kind of Mac.
  - Cockpit also sends a short record when it starts and stops, so the developer can
    count how many people run each version and how often it crashes. It holds nothing
    about your work.
  - Your home folder is replaced with ~. Your machine name, user, screenshots,
    recordings, crash memory dumps and file contents are never sent. Error text can
    still name a project or file.
  - Reports go to Sentry (EU) and are deleted after its retention period.

Full terms: https://github.com/Holodeck23/agent-cockpit/blob/main/BETA-TERMS.md

TERMS
  answer=${COCKPIT_ACCEPT_BETA_TERMS:-}
  if [ -z "$answer" ]; then
    printf 'Type "agree" to accept the terms and install: '
    { read -r answer </dev/tty; } 2>/dev/null || answer=
  fi
  [ "$answer" = agree ] || fail "not installed: the beta terms were not accepted."
  record_terms=1
fi

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

if [ -n "$record_terms" ]; then
  [ -d "$(dirname "$TERMS_FILE")" ] || mkdir -p -m 700 "$(dirname "$TERMS_FILE")" || true
  printf '{"version":%s,"acceptedAt":"%s","via":"installer"}\n' "$TERMS_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TERMS_FILE" \
    || say "Could not record the accepted terms; Cockpit will ask once when it opens."
fi

say "Cockpit $tag is in $DEST. Open it from there, or run: open \"$DEST/Cockpit.app\""
