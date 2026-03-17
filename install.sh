#!/usr/bin/env bash
set -euo pipefail

PACKAGE="${SECURITYCLAW_NPM_PACKAGE:-securityclaw}"
VERSION="${SECURITYCLAW_VERSION:-latest}"

if command -v npx >/dev/null 2>&1; then
  if [[ "${VERSION}" == "latest" ]]; then
    exec npx --yes "${PACKAGE}" install "$@"
  fi
  exec npx --yes "${PACKAGE}@${VERSION}" install "$@"
fi

if command -v npm >/dev/null 2>&1; then
  if [[ "${VERSION}" == "latest" ]]; then
    exec npm exec --yes --package "${PACKAGE}" securityclaw -- install "$@"
  fi
  exec npm exec --yes --package "${PACKAGE}@${VERSION}" securityclaw -- install "$@"
fi

echo "SecurityClaw installer requires npx or npm." >&2
exit 1
