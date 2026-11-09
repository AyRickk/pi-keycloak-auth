#!/usr/bin/env sh
# Starts or stops the throw-away Keycloak used by the end-to-end tests.
# Works with docker or podman (set CONTAINER_CLI to force one).
set -eu
CLI="${CONTAINER_CLI:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
NAME="pi-keycloak-auth-e2e"
IMAGE="${KC_IMAGE:-quay.io/keycloak/keycloak:26.4}"
PORT="${KC_PORT:-18080}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-up}" in
  up)
    "$CLI" rm -f "$NAME" >/dev/null 2>&1 || true
    "$CLI" run -d --name "$NAME" -p "$PORT:8080" \
      -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
      -e KC_HEALTH_ENABLED=true \
      -v "$DIR/test/e2e/keycloak/realm.json:/opt/keycloak/data/import/realm.json:ro" \
      "$IMAGE" start-dev --import-realm >/dev/null
    printf 'waiting for Keycloak on :%s ' "$PORT"
    i=0
    until curl -fsS "http://localhost:$PORT/realms/pi-test/.well-known/openid-configuration" >/dev/null 2>&1; do
      i=$((i + 1)); [ "$i" -gt 120 ] && { echo " timeout"; "$CLI" logs "$NAME" | tail -50; exit 1; }
      printf '.'; sleep 2
    done
    echo " ready: http://localhost:$PORT/realms/pi-test"
    ;;
  down) "$CLI" rm -f "$NAME" >/dev/null ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
