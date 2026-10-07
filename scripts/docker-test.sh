#!/bin/sh
# `bun run docker-test`: Gluon on clean Linux systems, in Docker. Offline and free: every
# container runs with --network none.
#
#   scripts/docker-test.sh [stage ...]      default: all stages, in this order
#
#   lint         shellcheck on install.sh and the test scripts
#   regression   typecheck, unit and e2e (every test) in oven/bun debian (glibc) and alpine (musl); the e2e part
#                runs GLUON_E2E_CONCURRENCY apps at once (default: scripts/e2e-concurrency.ts, by cores and free RAM, as locally) and passes
#                GLUON_TEST_SLOW on (CI sets both: its runners are slower)
#   npm          `bun run pack`'s tarball, `bun add -g` in both oven/bun images, then --version,
#                `bun publish` refused (private), and test/dist.test.ts (doctor, hostile cwd, the
#                grep worker) against the installed `gluon`
#   smoke        the release executables in plain ubuntu:24.04, debian:12-slim and alpine:3.20
#                (no Bun): --version, doctor with a fake claude, a hostile cwd; and install.sh
#                from a local release directory (`scripts/build.ts --all` + SHA256SUMS): a good
#                install, a tampered binary and a missing SHA256SUMS must fail with nothing installed
#   https        install.sh over https in oven/bun debian, against test/fixtures/https-release.ts
#                (self-signed): https, an https → https redirect, an https → http one refused
#
# Needs docker, bun (to build) and git. Exits non-zero when any step failed; prints a summary.

# The stage functions are called through step "$@".
# shellcheck disable=SC2329

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
VERSION="$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' package.json | head -n 1)"
[ -n "$VERSION" ] || { echo "docker-test: no version in package.json" >&2; exit 1; }

BUN_DEBIAN="oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f"
BUN_ALPINE="oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0"
SHELLCHECK="koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d"
BUN="bun --no-env-file --config=/dev/null"

stages="${*:-lint regression npm smoke https}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SUMMARY="$WORK/summary"
: > "$SUMMARY"
failed=0

section() { printf '\n==== %s\n' "$*"; }
# step <name> <command...>: runs it, records ok / FAIL with the time taken.
step() {
  name="$1"; shift
  section "$name"
  start=$(date +%s)
  if "$@"; then r=ok; else r=FAIL; failed=1; fi
  printf '%-4s  %-44s %4ss\n' "$r" "$name" "$(($(date +%s) - start))" >> "$SUMMARY"
}
want() { case " $stages " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# The build context for the Bun images: tracked and unignored files only (what a checkout has),
# never a node_modules: a symlinked one (a git worktree's) isn't matched by .gitignore's
# `node_modules/`, which matches directories only, and breaks the image's install.
context() {
  [ -d "$WORK/ctx" ] && return 0
  mkdir -p "$WORK/ctx"
  git ls-files -z --cached --others --exclude-standard -- . ':(exclude,glob)**/node_modules' ':(exclude,glob)**/node_modules/**' | tar --null -T - --ignore-failed-read -cf - 2>/dev/null | tar -xf - -C "$WORK/ctx" || return 1
  leaked="$(find "$WORK/ctx" -name '.env' -o -name '.env.*' ! -name '.env.example' | head -n 5)"
  if [ -n "$leaked" ]; then echo "docker-test: refusing a build context with $leaked" >&2; return 1; fi
}

bun_image() { # bun_image <flavor> <base>
  context && docker build -q -t "gluon-test-bun-$1" --build-arg "BASE=$2" -f test/docker/Dockerfile.regression "$WORK/ctx" >/dev/null
}

build_release() {
  $BUN scripts/build.ts --all || return 1
  mkdir -p "$WORK/release"
  for f in dist/gluon-bun-*; do ln "$f" "$WORK/release/" 2>/dev/null || cp "$f" "$WORK/release/" || return 1; done
  # As release.yml lays a release out: the installers are release files too, in SHA256SUMS.
  cp install.sh install.ps1 "$WORK/release/" || return 1
  (cd "$WORK/release" && sha256sum -- * > SHA256SUMS) || return 1
  chmod 755 "$WORK/release" && chmod a+r "$WORK/release"/*
  cat "$WORK/release/SHA256SUMS"
}

build_pack() {
  $BUN scripts/pack.ts || return 1
  mkdir -p "$WORK/pkg" && cp "dist/gluon-$VERSION.tgz" "$WORK/pkg/" && chmod -R a+rX "$WORK/pkg"
}

regression() { # regression <flavor>
  docker run --rm --init --network none -e GLUON_TEST_SLOW="${GLUON_TEST_SLOW:-}" "gluon-test-bun-$1" \
    sh -c 'bun run typecheck && bun run test:unit && bun run test:e2e --max-concurrency="$1"' sh "${GLUON_E2E_CONCURRENCY:-$($BUN scripts/e2e-concurrency.ts)}"
}

npm_install() { # npm_install <flavor>
  docker run --rm --init --network none -e VERSION="$VERSION" -v "$WORK/pkg:/pkg:ro" "gluon-test-bun-$1" sh -euc '
    # A user install, as a developer would have it (the image points BUN_INSTALL_BIN at /usr/local/bin).
    export BUN_INSTALL_BIN="$HOME/.bun/bin" PATH="$HOME/.bun/bin:$PATH"
    bun add -g "/pkg/gluon-$VERSION.tgz"
    bin="$(command -v gluon)"
    echo "installed: $bin -> $(readlink -f "$bin")"
    head -n 1 "$(readlink -f "$bin")"
    v="$(cd /tmp && gluon --version)"
    [ "$v" = "$VERSION" ] || { echo "--version printed $v"; exit 1; }
    echo "ok    gluon --version = $v"
    pkgdir="$(dirname "$(readlink -f "$bin")")"
    if out="$(cd "$pkgdir" && bun publish --dry-run 2>&1)"; then echo "bun publish --dry-run was not refused: $out"; exit 1; fi
    echo "$out" | grep -qi private || { echo "bun publish failed, but not for private: $out"; exit 1; }
    echo "ok    bun publish refuses it (private)"
    # Some dist.test.ts cases run gluon with a PATH of fake agents only; the npm route needs bun
    # on PATH (the bin is `env -S bun …`), so this wrapper adds bun'"'"'s directory (nothing else is in it).
    printf "#!/bin/sh\nPATH=\"\$PATH:%s\" exec %s \"\$@\"\n" "$(dirname "$(command -v bun)")" "$bin" > "$HOME/gluon-with-bun"
    chmod 755 "$HOME/gluon-with-bun"
    GLUON_TEST_BINARY="$HOME/gluon-with-bun" bun test test/dist.test.ts
  '
}

smoke() { # smoke <os>
  docker build -q -t "gluon-test-smoke-$1" -f "test/docker/Dockerfile.$1" test/docker >/dev/null &&
    docker run --rm --init --network none -e EXPECT_VERSION="$VERSION" \
      -v "$WORK/release:/release:ro" -v "$ROOT/install.sh:/install.sh:ro" "gluon-test-smoke-$1"
}

https_install() {
  docker run --rm --init --network none -e FIXTURE=/home/bun/gluon/test/fixtures/https-release.ts \
    -v "$WORK/release:/release:ro" -v "$ROOT/install.sh:/install.sh:ro" -v "$ROOT/test/docker/https.sh:/https.sh:ro" \
    gluon-test-bun-debian sh /https.sh
}

lint() {
  docker run --rm -v "$ROOT:/mnt:ro" "$SHELLCHECK" install.sh scripts/docker-test.sh test/docker/smoke.sh test/docker/https.sh
}

want lint && step "lint: shellcheck" lint
if want regression || want npm || want https; then
  step "image: oven/bun debian" bun_image debian "$BUN_DEBIAN"
  step "image: oven/bun alpine" bun_image alpine "$BUN_ALPINE"
fi
if want regression; then
  step "regression: oven/bun debian" regression debian
  step "regression: oven/bun alpine" regression alpine
fi
if want npm; then
  step "pack: npm tarball" build_pack
  step "npm: bun add -g in oven/bun debian" npm_install debian
  step "npm: bun add -g in oven/bun alpine" npm_install alpine
fi
if want smoke || want https; then
  step "build: release dir (build.ts --all + SHA256SUMS)" build_release
fi
if want smoke; then
  for os in ubuntu debian alpine; do step "smoke + install.sh: $os" smoke "$os"; done
fi

want https && step "https: install.sh over https (oven/bun debian)" https_install

section "summary (gluon $VERSION)"
cat "$SUMMARY"
exit "$failed"
