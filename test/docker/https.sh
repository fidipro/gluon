#!/bin/sh
# install.sh over https, against a local server (test/fixtures/https-release.ts) with a self-signed
# certificate: run by scripts/docker-test.sh in the oven/bun debian image (curl, openssl, bun), with
# --network none.
#
#   /release      (read-only) the release files and SHA256SUMS
#   /install.sh   (read-only) the installer
#   FIXTURE       the fixture's path

set -u

pass=0
fails=0
ok() { pass=$((pass + 1)); printf 'ok    %s\n' "$1"; }
bad() {
  fails=$((fails + 1))
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/      /'; fi
}
has() { printf "%s" "$1" | grep -Eq -- "$2"; }

asset="gluon-bun-linux-x64"
case "$(uname -m)" in aarch64|arm64) asset="gluon-bun-linux-arm64" ;; esac
bin="/release/$asset"

W="$(mktemp -d)"
server=""
trap 'if [ -n "$server" ]; then kill "$server"; fi; rm -rf "$W"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout "$W/key.pem" -out "$W/cert.pem" >/dev/null 2>&1 ||
  { echo "openssl failed"; exit 1; }
RELEASE_DIR=/release TLS_CERT="$W/cert.pem" TLS_KEY="$W/key.pem" HTTPS_PORT=8443 HTTP_PORT=8080 HTTP_LOG="$W/http.log" \
  bun "$FIXTURE" > "$W/server.log" 2>&1 &
server=$!
i=0
until grep -q ready "$W/server.log" 2>/dev/null; do
  i=$((i + 1))
  if [ $i -gt 100 ]; then echo "the fixture didn't start:"; cat "$W/server.log"; exit 1; fi
  sleep 0.1
done
: > "$W/http.log"

inst() { env HOME="$W/home" CURL_CA_BUNDLE="$W/cert.pem" "$@" sh /install.sh 2>&1; }

out="$(inst GLUON_RELEASE_URL=https://localhost:8443/r GLUON_INSTALL_DIR="$W/i1")"; code=$?
if [ $code -eq 0 ] && cmp -s "$bin" "$W/i1/gluon"; then ok "BUG-118: install over https (curl)"; else bad "BUG-118: https install" "exit $code: $out"; fi

out="$(inst GLUON_RELEASE_URL=https://localhost:8443/to-https GLUON_INSTALL_DIR="$W/i2")"; code=$?
if [ $code -eq 0 ] && cmp -s "$bin" "$W/i2/gluon"; then ok "BUG-118: an https → https redirect is followed"; else bad "BUG-118: https redirect" "exit $code: $out"; fi

out="$(inst GLUON_RELEASE_URL=https://localhost:8443/to-http GLUON_INSTALL_DIR="$W/i3")"; code=$?
if [ $code -ne 0 ] && [ ! -e "$W/i3/gluon" ] && [ ! -s "$W/http.log" ]; then
  ok "BUG-118: an https → http redirect is refused (the http server saw nothing)"
else
  bad "BUG-118: https → http redirect" "exit $code: $out; http log: $(cat "$W/http.log")"
fi

out="$(inst GLUON_RELEASE_URL=HTTPS://LOCALHOST:8443/r GLUON_INSTALL_DIR="$W/i4")"; code=$?
if [ $code -eq 0 ] && cmp -s "$bin" "$W/i4/gluon"; then ok "BUG-127: HTTPS:// in capitals is https"; else bad "BUG-127: HTTPS://" "exit $code: $out"; fi

out="$(env HOME="$W/home" GLUON_RELEASE_URL=https://localhost:8443/r GLUON_INSTALL_DIR="$W/i5" sh /install.sh 2>&1)"; code=$?
if [ $code -ne 0 ] && [ ! -e "$W/i5/gluon" ]; then ok "an untrusted certificate fails, nothing installed"; else bad "untrusted certificate" "exit $code: $out"; fi

out="$(inst GLUON_RELEASE_URL=https://localhost:8443/nothing-here GLUON_INSTALL_DIR="$W/i6")"; code=$?
if [ $code -ne 0 ] && has "$out" "could not get SHA256SUMS" && [ ! -e "$W/i6" ]; then ok "a 404 fails, nothing installed"; else bad "404" "exit $code: $out"; fi

printf '== https: %d passed, %d failed\n' "$pass" "$fails"
[ "$fails" -eq 0 ]
