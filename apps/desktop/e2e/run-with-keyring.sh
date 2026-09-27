#!/usr/bin/env bash
# Runs a command with a throwaway, unlocked gnome-keyring so Electron safeStorage uses the
# real Secret Service backend (Linux "os" vault level). Must run inside a private D-Bus session:
#   dbus-run-session -- bash e2e/run-with-keyring.sh <command...>
# NOVA_KEYRING_ROOT may point to a locally extracted package root (no system install),
# e.g. .devdeps/linux-gui/root on a dev machine without root access.
set -euo pipefail

daemon="gnome-keyring-daemon"
if [[ -n "${NOVA_KEYRING_ROOT:-}" ]]; then
  daemon="${NOVA_KEYRING_ROOT}/usr/bin/gnome-keyring-daemon"
  export LD_LIBRARY_PATH="${NOVA_KEYRING_ROOT}/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

scratch="$(mktemp -d)"
export XDG_DATA_HOME="${scratch}/data"
export XDG_RUNTIME_DIR="${scratch}/runtime"
mkdir -p "${XDG_DATA_HOME}" "${XDG_RUNTIME_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}"

trap 'rm -rf "${scratch}"' EXIT

# The daemon forks and outlives this call; with stderr on /dev/null it holds none of the caller's
# pipes (a `... | tail` would otherwise never see EOF). It exits with the private session bus.
eval "$(printf 'nova-e2e\n' | "${daemon}" --unlock --components=secrets 2>/dev/null)"
export GNOME_KEYRING_CONTROL
# Chromium picks the Secret Service backend from the desktop session, as on a real GNOME desktop.
export XDG_CURRENT_DESKTOP=GNOME
export NOVA_E2E_KEYRING=1

"$@"
