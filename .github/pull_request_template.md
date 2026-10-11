## What and why

<!-- What does this change, and why? Link the issue it fixes. -->

## Checklist

- [ ] `bun run regression` passes
- [ ] A fixed bug made its catalog entry's test fail first, tagged `#BUG-nn`; a new behaviour has its entry and test
- [ ] Catalog or seams changed (`test/catalog.ts`, `test/seams.ts`)? Say which and why, for the maintainer's `tests-reviewed`
- [ ] `AGENTS.md` / `README.md` updated if a command, file, workflow or behaviour changed
- [ ] Behaviour changed? Updated the guide in `docs/` that describes it (guide footers list the files they describe); ran `bun run docs:gen` if CLI/config/models changed
- [ ] Keeps the hard rules for subscriptions (see `CONTRIBUTING.md`)
- [ ] Every commit is signed off (`git commit -s`, see `CONTRIBUTING.md`; checked for outside contributors)
- [ ] No real keys, tokens or personal data in code, tests, logs or screenshots

<!-- Keeping this file fresh:
Update when the workflow in AGENTS.md or CONTRIBUTING.md changes (what 'done' means, what to
update).
-->
