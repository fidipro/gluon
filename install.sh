#!/bin/sh
# Gluon installer for Linux and macOS (Windows: install.ps1).
#
#   curl -fsSL https://github.com/fidipro/gluon/releases/latest/download/install.sh | sh
#
# Downloads the release executable for this machine, checks it against the release's SHA256SUMS
# (no match, no install), checks SHA256SUMS's signature when cosign is installed and the release
# is signed, and installs it as ~/.local/bin/gluon. No sudo; nothing outside the install dir
# is touched. Needs curl for https downloads.
#
# Environment:
#   GLUON_VERSION       a version such as 1.0.0 (default: latest, the newest published
#                       GitHub release of fidipro/gluon)
#   GLUON_RELEASE_URL   where the release files are: an https:// base URL, a file:// URL or a
#                       local directory holding gluon-bun-<os>-<arch>[-musl] and SHA256SUMS.
#                       It wins over GLUON_VERSION.
#   GLUON_INSTALL_DIR   where to install (default: ~/.local/bin)
#
# This script never carries or asks for a token. To install a release GitHub doesn't serve
# anonymously (a draft or a pre-release), download it with your own gh login and install from
# that directory:
#
#   gh release download v1.0.0 -R fidipro/gluon -D gluon-release
#   GLUON_RELEASE_URL=./gluon-release sh gluon-release/install.sh
#
# Everything runs from main, called on the last line: a download cut short runs nothing.

set -eu

REPO="fidipro/gluon"
CERT_IDENTITY="https://github.com/$REPO/.github/workflows/release.yml@refs/heads/main"
CERT_ISSUER="https://token.actions.githubusercontent.com"

say() { printf '%s\n' "$*"; }
err() { printf 'gluon install: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

tmp=""
staged=""
cleanup() {
  if [ -n "$staged" ]; then rm -f "$staged"; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}

# fetch <file name> <destination>: 1 when the file can't be had. https only, redirects included
# (--proto-redir: curl would otherwise follow a redirect to http).
fetch() {
  if [ "$source_kind" = local ]; then
    [ -f "$base/$1" ] || return 1
    cp "$base/$1" "$2"
  else
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o "$2" "$base/$1"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else
    die "needs sha256sum, shasum or openssl to check the download"
  fi
}

# glibc or musl. ldd names its libc; /lib/ld-musl-* alone isn't enough (Debian's musl package
# puts one on a glibc system: BUG-117), so it decides only when ldd says nothing.
detect_libc() {
  ldd_out="$(ldd --version 2>&1 || true)"
  case "$ldd_out" in
    *musl*) echo musl; return ;;
    *GLIBC*|*"GNU libc"*|*glibc*|*"GNU C Library"*) echo glibc; return ;;
  esac
  if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then echo glibc; return; fi
  for f in /lib/ld-musl-*; do
    if [ -e "$f" ]; then echo musl; return; fi
  done
  echo glibc
}

main() {
  version="${GLUON_VERSION:-latest}"
  if [ "$version" != latest ] && ! printf '%s' "$version" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
    die "GLUON_VERSION must be a version such as 1.0.0 (or latest), not: $version"
  fi
  if [ -n "${GLUON_INSTALL_DIR:-}" ]; then
    install_dir="$GLUON_INSTALL_DIR"
  else
    [ -n "${HOME:-}" ] || die "HOME is not set; set GLUON_INSTALL_DIR"
    install_dir="$HOME/.local/bin"
  fi

  # --- where the release is -----------------------------------------------------------------
  source_kind=https
  if [ -n "${GLUON_RELEASE_URL:-}" ]; then
    base="${GLUON_RELEASE_URL%/}"
    scheme="$(printf '%s' "$base" | sed -n 's|^\([A-Za-z][A-Za-z0-9+.-]*\)://.*|\1|p' | tr '[:upper:]' '[:lower:]')"
    case "$scheme" in
      https) ;;
      file) source_kind=local; base="${base#???????}" ;;
      "") source_kind=local ;;
      *) die "refusing $base: only https:// (or a local directory) is allowed" ;;
    esac
    [ "$source_kind" = https ] || [ -d "$base" ] || die "no such directory: $base"
  elif [ "$version" = latest ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/v${version#v}"
  fi
  if [ "$source_kind" = https ] && ! command -v curl >/dev/null 2>&1; then
    die "needs curl to download; install it and run this again"
  fi

  # --- this machine -------------------------------------------------------------------------
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW*|MSYS*|CYGWIN*) die "on Windows, run install.ps1 in PowerShell" ;;
    *) die "unsupported OS: $(uname -s) (Linux and macOS are supported)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported CPU: $(uname -m) (x64 and arm64 are supported)" ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple silicon Mac: take the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  libc=""
  if [ "$os" = linux ] && [ "$(detect_libc)" = musl ]; then libc=-musl; fi
  asset="gluon-bun-$os-$arch$libc"

  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t gluon)"

  # --- download and check -------------------------------------------------------------------
  say "Installing Gluon ($asset) from $base"
  if ! fetch SHA256SUMS "$tmp/SHA256SUMS"; then
    die "could not get SHA256SUMS from $base; nothing installed"
  fi
  if ! fetch "$asset" "$tmp/$asset"; then
    die "could not get $asset from $base; nothing installed"
  fi

  # The line for this file: "<hash>  <name>" or "<hash> *<name>" (binary mode); CRLF lines too.
  expected="$(tr -d '\r' < "$tmp/SHA256SUMS" | awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' | tr 'A-F' 'a-f')"
  [ -n "$expected" ] || die "SHA256SUMS has no entry for $asset; nothing installed"
  actual="$(sha256 "$tmp/$asset")"
  if [ "$actual" != "$expected" ]; then
    err "checksum mismatch for $asset"
    err "  expected $expected"
    err "  got      $actual"
    die "the download is not the released file; nothing installed"
  fi
  say "  sha256 ok  $actual"

  if command -v cosign >/dev/null 2>&1; then
    if fetch SHA256SUMS.sigstore.json "$tmp/SHA256SUMS.sigstore.json" 2>/dev/null; then
      if cosign verify-blob --bundle "$tmp/SHA256SUMS.sigstore.json" \
        --certificate-identity "$CERT_IDENTITY" --certificate-oidc-issuer "$CERT_ISSUER" \
        "$tmp/SHA256SUMS" >/dev/null 2>&1; then
        say "  signature ok  (cosign, $CERT_IDENTITY)"
      else
        die "the signature on SHA256SUMS does not verify; nothing installed"
      fi
    else
      say "  signature: this release has no SHA256SUMS.sigstore.json; skipped"
    fi
  else
    say "  signature: cosign is not installed; skipped (the checksum was checked)"
  fi

  # --- install ------------------------------------------------------------------------------
  mkdir -p "$install_dir"
  install_dir="$(cd "$install_dir" && pwd)"
  target="$install_dir/gluon"
  if [ -d "$target" ]; then die "$target is a directory; nothing installed"; fi
  staged="$install_dir/.gluon.$$.tmp"
  cp "$tmp/$asset" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$target"
  staged=""
  say "Installed $target"

  if [ -n "$libc" ]; then
    say ""
    say "On Alpine and other musl systems Gluon needs libstdc++ and libgcc:"
    say "  apk add libstdc++ libgcc"
  fi

  if ! (cd "$tmp" && "$target" --version </dev/null >/dev/null 2>&1); then
    err "warning: $target --version did not run on this machine"
  fi

  case ":${PATH:-}:" in
    *":$install_dir:"*) ;;
    *)
      say ""
      say "$install_dir is not on your PATH. Add it, e.g. in ~/.profile or your shell's rc file:"
      say "  export PATH=\"$install_dir:\$PATH\""
      ;;
  esac

  if [ -n "${XDG_CONFIG_HOME:-}" ]; then config_dir="$XDG_CONFIG_HOME/gluon"
  elif [ -n "${HOME:-}" ]; then config_dir="$HOME/.config/gluon"
  else
    # shellcheck disable=SC2088 # printed for the user, not expanded
    config_dir="~/.config/gluon"
  fi
  say ""
  say "Get started: gluon"
  say "Uninstall:   gluon uninstall   (removes the binary, config and saved API keys)"
  say "             by hand: rm \"$target\"; rm -rf \"$config_dir\""
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
main "$@"
