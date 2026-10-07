#!/bin/sh
# The release executable and install.sh in a plain OS image (no Bun): run by scripts/docker-test.sh
# in test/docker/Dockerfile.{ubuntu,debian,alpine}, as a non-root user.
#
#   /release      (read-only) the release files: gluon-bun-<os>-<arch>[-musl] and SHA256SUMS
#   /install.sh   (read-only) the installer
#   EXPECT_VERSION  the version --version must print
#
# Prints one line per check and exits non-zero when any failed.

set -u

pass=0
fails=0
ok() { pass=$((pass + 1)); printf 'ok    %s\n' "$1"; }
bad() {
  fails=$((fails + 1))
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/      /'; fi
}
# has <output> <grep -E pattern>
has() { printf "%s" "$1" | grep -Eq -- "$2"; }

arch=x64
case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; esac
libc=""
if ldd --version 2>&1 | grep -qi musl; then libc=-musl; fi
asset="gluon-bun-linux-$arch$libc"
bin="/release/$asset"
# shellcheck source=/dev/null
. /etc/os-release
printf '== %s %s, %s, as %s\n' "$ID" "$VERSION_ID" "$asset" "$(id -un)"

W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin" "$W/home" "$W/cfg"
export HOME="$W/home"
SYS_PATH=/usr/local/bin:/usr/bin:/bin

# A fake `claude`: version, a signed-in plan, a working `-p` ping; a launch prints what it got.
cat > "$W/bin/claude" <<'EOF'
#!/bin/sh
case "$1" in
  --version) echo "2.1.284 (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}'; exit 0 ;;
  -p) echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'; exit 0 ;;
esac
echo "FAKE-CLAUDE ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-unset}"
EOF
chmod 755 "$W/bin/claude"
cfg="$W/cfg/config.yaml"
printf 'connections: { claude-code: { auth: subscription } }\n' > "$cfg"
run() { env PATH="$W/bin:$SYS_PATH" GLUON_CONFIG="$cfg" "$@" 2>&1; }

# --- the executable ---------------------------------------------------------------------------
out="$(run "$bin" --version)"; code=$?
if [ $code -eq 0 ] && [ "$out" = "$EXPECT_VERSION" ]; then ok "--version prints $EXPECT_VERSION"; else bad "--version" "exit $code: $out"; fi

out="$(run "$bin" --help)"; code=$?
if [ $code -eq 0 ] && has "$out" "gluon $EXPECT_VERSION"; then ok "--help"; else bad "--help" "exit $code: $out"; fi

out="$(cd "$W" && run "$bin" doctor)"; code=$?
if [ $code -eq 0 ] && has "$out" "Claude Code \(claude 2\.1\.284\)"; then ok "doctor with a fake claude"; else bad "doctor with a fake claude" "exit $code: $out"; fi

# --- a hostile working directory (BUG-56 / BUG-99 / BUG-101 class) ----------------------------
H="$W/hostile"
KEY="sk-ant-hostile-0123456789abcdefghij"
mkdir -p "$H/node_modules/react-devtools-core" "$H/agent"
printf 'preload = ["./p.ts"]\n' > "$H/bunfig.toml"
printf 'require("node:fs").writeFileSync("%s/PRELOAD-RAN", "x");\n' "$W" > "$H/p.ts"
printf 'ANTHROPIC_API_KEY=%s\nOPENAI_API_KEY=%s\n' "$KEY" "$KEY" > "$H/.env"
printf '{ "name": "hostile", "type": "module" }\n' > "$H/package.json"
printf '{ "compilerOptions": { "paths": { "react": ["./p.ts"] } } }\n' > "$H/tsconfig.json"
printf '{ "name": "react-devtools-core", "version": "9.9.9", "main": "index.js" }\n' > "$H/node_modules/react-devtools-core/package.json"
printf 'require("node:fs").writeFileSync("%s/DEVTOOLS-RAN", "x"); module.exports = { initialize() {}, connectToDevTools() {} };\n' "$W" > "$H/node_modules/react-devtools-core/index.js"
for f in grep-worker.ts grep-worker.js; do printf 'require("node:fs").writeFileSync("%s/WORKER-RAN", "x");\n' "$W" > "$H/agent/$f"; done

out="$(cd "$H" && run env DEV=true "$bin" --version)"; code=$?
if [ $code -eq 0 ]; then ok "hostile cwd: DEV=true --version"; else bad "hostile cwd: DEV=true --version" "exit $code: $out"; fi
out="$(cd "$H" && run "$bin" doctor)"; code=$?
if [ $code -eq 0 ] && has "$out" "ANTHROPIC_API_KEY isn't set" && ! has "$out" "ANTHROPIC_API_KEY is set in your environment|$KEY"; then ok "hostile cwd: doctor sees no key from .env"; else bad "hostile cwd: doctor" "exit $code: $out"; fi
out="$(cd "$H" && run "$bin" --launch claude-code --model sonnet --dry-run -- x)"; code=$?
if [ $code -eq 0 ] && has "$out" '"env": \{\}' && ! has "$out" "$KEY"; then ok "hostile cwd: a launch gets no key from .env"; else bad "hostile cwd: dry run" "exit $code: $out"; fi
for m in PRELOAD-RAN DEVTOOLS-RAN WORKER-RAN; do
  if [ -e "$W/$m" ]; then bad "hostile cwd: $m exists"; else ok "hostile cwd: no $m"; fi
done

# --- install.sh -------------------------------------------------------------------------------
# release <dir> [tamper|nosums|noentry]: a release directory with this machine's file.
release() {
  mkdir -p "$1"
  case "${2:-}" in
    tamper) cp "$bin" "$1/$asset"; printf 'x' >> "$1/$asset" ;;
    *) ln -s "$bin" "$1/$asset" ;;
  esac
  case "${2:-}" in
    nosums) ;;
    noentry) grep -v " $asset\$" /release/SHA256SUMS > "$1/SHA256SUMS" ;;
    *) cp /release/SHA256SUMS "$1/SHA256SUMS" ;;
  esac
}
inst() { env PATH="$SYS_PATH" HOME="$HOME" GLUON_VERSION="" "$@" sh /install.sh 2>&1; }

out="$(inst GLUON_RELEASE_URL=/release GLUON_INSTALL_DIR="$W/i1")"; code=$?
if [ $code -eq 0 ] && cmp -s "$bin" "$W/i1/gluon" && [ -x "$W/i1/gluon" ] && has "$out" "sha256 ok" && has "$out" "is not on your PATH" && has "$out" "Uninstall:"; then
  ok "install.sh: good install"
else
  bad "install.sh: good install" "exit $code: $out"
fi
if [ "$(ls -A "$W/i1")" = gluon ]; then ok "install.sh: nothing but the binary left in the install dir"; else bad "install.sh: leftovers" "$(ls -la "$W/i1")"; fi
perm="$(stat -c %a "$W/i1/gluon" 2>/dev/null || stat -f %Lp "$W/i1/gluon")"
if [ "$perm" = 755 ]; then ok "install.sh: mode 755"; else bad "install.sh: mode $perm"; fi
v="$("$W/i1/gluon" --version 2>&1)"
if [ "$v" = "$EXPECT_VERSION" ]; then ok "install.sh: the installed binary runs"; else bad "install.sh: installed binary" "$v"; fi
if [ -n "$libc" ]; then
  if has "$out" "apk add libstdc\+\+ libgcc"; then ok "install.sh: musl note"; else bad "install.sh: musl note missing" "$out"; fi
fi

out="$(inst HOME="$W/home2" GLUON_RELEASE_URL="file:///release")"; code=$?
if [ $code -eq 0 ] && cmp -s "$bin" "$W/home2/.local/bin/gluon"; then ok "install.sh: file:// URL, default dir ~/.local/bin"; else bad "install.sh: file:// URL" "exit $code: $out"; fi

out="$(env PATH="$W/i1:$SYS_PATH" GLUON_RELEASE_URL=/release GLUON_INSTALL_DIR="$W/i1" sh /install.sh 2>&1)"; code=$?
if [ $code -eq 0 ] && ! has "$out" "is not on your PATH"; then ok "install.sh: reinstall over itself, no PATH hint when on PATH"; else bad "install.sh: reinstall" "exit $code: $out"; fi

release "$W/r-tamper" tamper
out="$(inst GLUON_RELEASE_URL="$W/r-tamper" GLUON_INSTALL_DIR="$W/i2")"; code=$?
if [ $code -ne 0 ] && has "$out" "checksum mismatch" && [ ! -e "$W/i2/gluon" ]; then ok "install.sh: tampered binary fails closed, nothing installed"; else bad "install.sh: tampered binary" "exit $code: $out"; fi
out="$(inst GLUON_RELEASE_URL="$W/r-tamper" GLUON_INSTALL_DIR="$W/i1")"; code=$?
if [ $code -ne 0 ] && cmp -s "$bin" "$W/i1/gluon" && [ "$(ls -A "$W/i1")" = gluon ]; then ok "install.sh: tampered binary leaves an existing install as it was"; else bad "install.sh: tampered over an install" "exit $code: $out"; fi

release "$W/r-nosums" nosums
out="$(inst GLUON_RELEASE_URL="$W/r-nosums" GLUON_INSTALL_DIR="$W/i3")"; code=$?
if [ $code -ne 0 ] && has "$out" "could not get SHA256SUMS" && [ ! -e "$W/i3/gluon" ]; then ok "install.sh: missing SHA256SUMS fails closed"; else bad "install.sh: missing SHA256SUMS" "exit $code: $out"; fi

release "$W/r-noentry" noentry
out="$(inst GLUON_RELEASE_URL="$W/r-noentry" GLUON_INSTALL_DIR="$W/i4")"; code=$?
if [ $code -ne 0 ] && has "$out" "no entry for $asset" && [ ! -e "$W/i4/gluon" ]; then ok "install.sh: no SHA256SUMS entry fails closed"; else bad "install.sh: no entry" "exit $code: $out"; fi

out="$(inst GLUON_RELEASE_URL="http://example.invalid/r" GLUON_INSTALL_DIR="$W/i5")"; code=$?
if [ $code -ne 0 ] && has "$out" "only https://" && [ ! -e "$W/i5" ]; then ok "install.sh: plain http refused"; else bad "install.sh: http" "exit $code: $out"; fi

out="$(inst GLUON_RELEASE_URL="$W/does-not-exist" GLUON_INSTALL_DIR="$W/i6")"; code=$?
if [ $code -ne 0 ] && has "$out" "no such directory"; then ok "install.sh: a missing local directory fails"; else bad "install.sh: missing dir" "exit $code: $out"; fi

# BUG-117: a glibc system with musl's loader installed (Dockerfile.debian installs Debian's musl).
if [ -z "$libc" ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
  out="$(inst GLUON_RELEASE_URL=/release GLUON_INSTALL_DIR="$W/i7")"; code=$?
  if [ $code -eq 0 ] && has "$out" "\($asset\)" && cmp -s "$bin" "$W/i7/gluon"; then ok "BUG-117: glibc with /lib/ld-musl-* installed takes the glibc build"; else bad "BUG-117: glibc + musl loader" "exit $code: $out"; fi
fi

# BUG-122: the target is a directory, or a symlink to one.
mkdir -p "$W/i8/gluon" "$W/i9" "$W/elsewhere"
ln -s "$W/elsewhere" "$W/i9/gluon"
for d in i8 i9; do
  out="$(inst GLUON_RELEASE_URL=/release GLUON_INSTALL_DIR="$W/$d")"; code=$?
  if [ $code -ne 0 ] && has "$out" "is a directory" && [ -z "$(ls -A "$W/$d/gluon/")" ] && ! has "$out" "Installed"; then ok "BUG-122: refuses a target that is a directory ($d)"; else bad "BUG-122: directory target ($d)" "exit $code: $out"; fi
done

# BUG-123: HOME unset, GLUON_INSTALL_DIR set.
out="$(env -u HOME PATH="$SYS_PATH" GLUON_RELEASE_URL=/release GLUON_INSTALL_DIR="$W/i10" sh /install.sh 2>&1)"; code=$?
if [ $code -eq 0 ] && [ -x "$W/i10/gluon" ] && has "$out" "Uninstall:"; then ok "BUG-123: HOME unset with GLUON_INSTALL_DIR works"; else bad "BUG-123: HOME unset" "exit $code: $out"; fi
out="$(env -u HOME PATH="$SYS_PATH" GLUON_RELEASE_URL=/release sh /install.sh 2>&1)"; code=$?
if [ $code -ne 0 ] && has "$out" "HOME is not set"; then ok "BUG-123: HOME unset without GLUON_INSTALL_DIR says so"; else bad "BUG-123: HOME unset, no dir" "exit $code: $out"; fi

# BUG-124: a relative GLUON_INSTALL_DIR is made absolute (hints and the PATH check).
out="$(cd "$W" && env PATH="$W/rel/bin:$SYS_PATH" HOME="$HOME" GLUON_RELEASE_URL=/release GLUON_INSTALL_DIR=rel/bin sh /install.sh 2>&1)"; code=$?
if [ $code -eq 0 ] && has "$out" "Installed $W/rel/bin/gluon" && ! has "$out" "not on your PATH"; then ok "BUG-124: a relative install dir is made absolute"; else bad "BUG-124: relative dir" "exit $code: $out"; fi

# BUG-125: GLUON_VERSION is a version or latest.
for v in "garbage" "1.0" "1.0.0/../../x" "1.0.0; rm -rf ~"; do
  out="$(env PATH="$SYS_PATH" HOME="$HOME" GLUON_VERSION="$v" GLUON_INSTALL_DIR="$W/i11" sh /install.sh 2>&1)"; code=$?
  if [ $code -ne 0 ] && has "$out" "must be a version" && [ ! -e "$W/i11" ]; then ok "BUG-125: GLUON_VERSION=$v refused"; else bad "BUG-125: GLUON_VERSION=$v" "exit $code: $out"; fi
done

# BUG-127: CRLF SHA256SUMS; FILE:// in capitals; a truncated script runs nothing.
mkdir -p "$W/r-crlf"; ln -s "$bin" "$W/r-crlf/$asset"; sed 's/$/\r/' /release/SHA256SUMS > "$W/r-crlf/SHA256SUMS"
out="$(inst GLUON_RELEASE_URL="$W/r-crlf" GLUON_INSTALL_DIR="$W/i12")"; code=$?
if [ $code -eq 0 ] && cmp -s "$bin" "$W/i12/gluon"; then ok "BUG-127: a CRLF SHA256SUMS is read"; else bad "BUG-127: CRLF" "exit $code: $out"; fi
mkdir -p "$W/r-crlf-bad"; cp "$bin" "$W/r-crlf-bad/$asset"; printf 'x' >> "$W/r-crlf-bad/$asset"; cp "$W/r-crlf/SHA256SUMS" "$W/r-crlf-bad/"
out="$(inst GLUON_RELEASE_URL="$W/r-crlf-bad" GLUON_INSTALL_DIR="$W/i13")"; code=$?
if [ $code -ne 0 ] && has "$out" "checksum mismatch" && [ ! -e "$W/i13/gluon" ]; then ok "BUG-127: CRLF SHA256SUMS still fails closed on a mismatch"; else bad "BUG-127: CRLF mismatch" "exit $code: $out"; fi
out="$(inst GLUON_RELEASE_URL="FILE:///release" GLUON_INSTALL_DIR="$W/i14")"; code=$?
if [ $code -eq 0 ] && cmp -s "$bin" "$W/i14/gluon"; then ok "BUG-127: FILE:// in capitals"; else bad "BUG-127: FILE://" "exit $code: $out"; fi
lines=$(wc -l < /install.sh)
for n in $((lines - 3)) $((lines / 2)); do
  out="$(head -n "$n" /install.sh | env PATH="$SYS_PATH" HOME="$HOME" GLUON_RELEASE_URL=/release GLUON_INSTALL_DIR="$W/i15" sh 2>&1)"
  if [ ! -e "$W/i15" ] && ! has "$out" "Installing"; then ok "BUG-127: install.sh cut at line $n runs nothing"; else bad "BUG-127: truncated at $n" "$out"; fi
done

printf '== %s %s: %d passed, %d failed\n' "$ID" "$VERSION_ID" "$pass" "$fails"
[ "$fails" -eq 0 ]
