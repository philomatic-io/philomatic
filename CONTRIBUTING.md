# Contributing to Philomatic

Thanks for wanting to make the learning commons better. Two ground rules keep the project's
legal footing clear — please read them before your first PR.

## 1. Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/) — that you wrote the
change, or otherwise have the right to submit it under this repository's licenses:

```bash
git commit -s -m "fix: the thing"
# adds: Signed-off-by: Your Name <you@example.com>
```

That's the whole requirement: a DCO certifies provenance. You keep your copyright; your
contribution lands under the license of the files it touches, same terms as everyone.

Stated plainly, because you deserve to know the model you're contributing to: Philomatic is
open core. The plan is that revenue, if any, comes from things the maintainer operates and
builds — hosting, infrastructure, compute-backed enrichment — not from access to what
contributors made, and not from relicensing this repository.

## 2. Know the license split

- **Implementation** (engine, server, registry, workbench, extension, plugin): **AGPL-3.0**
  (`LICENSE`). If you modify Philomatic and serve it to others over a network, you share your
  changes. Self-hosting for yourself carries no obligations beyond keeping the notices.
- **Formats and wire contracts** (`src/schema/`, the publication bundle format, the capture
  and read contract shapes): **MIT** (`LICENSE-MIT`). Build anything that speaks Philomatic's
  formats — open or closed, ours or a competitor's — without copyleft obligations. The
  protocol is commons; the implementation is copyleft.

Contributions land under the license of the files they touch.

## Practicalities

- **Bugs and small fixes**: PRs welcome directly. Include a test that pins the fix — this
  codebase treats regressions as data.
- **Features**: open an issue first. The project runs deliberate feature phases; a PR built
  on an unvetted design usually can't merge no matter how good the code is.
- **Data governance**: challenges to the data principles are contributions — open an issue.
- Run `pnpm test` (vitest) before pushing; `pnpm ui:build` if you touched the workbench.
- Conventions: TypeScript strict, comments explain constraints (not narration), tests pin
  behavior with the reason in the test name.
