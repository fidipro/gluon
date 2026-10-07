# scripts/ — instructions for coding agents

Build, pack, Docker and live-test scripts; also covers `install.sh`, `install.ps1` and
`.github/workflows/`.

- **`GLUON_BUILD`** is a `define` ("release" / "test" / "npm"; undefined from source; no env
  var sets it: BUG-97). Read it as `BUILD`, or `typeof GLUON_BUILD` where it must fold.
  Every `GLUON_TEST_*` seam folds away in release builds that way (`testProbesPath`), and
  `test/dist.test.ts` checks the release binary doesn't contain its name.
- **Compiled binaries have every `autoload*` off** (`build.ts`); `dist.test.ts` proves it from a
  hostile cwd.
- **Nothing in a compiled binary is `external`** — it would resolve from the repo's
  `node_modules`. Ink DEV and `react-devtools-core` are stubbed; the build fails if they reappear
  (BUG-99).
- **Never ship a cross-built binary**: `--bytecode` cross-built segfaults (Bun 1.3.14), so it's
  host-only; `release.yml` builds each target natively. Cross-built darwin binaries are unsigned.
- **musl binaries need `libstdc++ libgcc`** on Alpine.
- **The npm bundle's bin is `env -S bun …`**: POSIX only, needs `bun` on PATH (Alpine: coreutils).
- **Installers fail closed**: no/mismatched SHA256SUMS installs nothing; only https / file:// /
  local dir; https on every hop (BUG-118/119); libc from `ldd --version` first (BUG-117);
  `install.ps1` is one `& { … } @args` block (BUG-120). Details: `docs/getting-started/install.md`.
- **`docker-test`'s build context is tracked files only**; Dockerfiles are digest-pinned.
- **`scripts/pricing/` generators are deterministic and read binaries as bytes** (never evaluated; a
  harness is asked at most `--version`), always from `--binary` (never PATH). They fetch only with `--live`, which only a
  maintainer's manual refresh passes (BUG-520). A key a generator writes is added to `src/cost/table-schema.ts` first, or `validate.ts` refuses the table.
- **Workflow actions are pinned by SHA**; `.gitleaks.toml` allowlists the fake test keys.

## Keeping this file fresh

Follow "Keeping AGENTS.md files fresh" in the root `AGENTS.md`. In short: update it in the change
that makes a line wrong; delete what stops being true or a test now enforces; add only what an
agent would get wrong; every name must exist; ≤ 70 lines, overflow to `docs/`.
