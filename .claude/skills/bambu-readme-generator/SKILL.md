---
name: bambu-readme-generator
description: Generate or refresh a project's root README.md by autodiscovering its real state — language/runtime, package manager, project layout (src / apps / libs / packages / services / modules / etc.), available scripts, and main top-level files. Load this skill whenever the user asks to "generate the README", "update the README", "regenerate project docs", "refresh the docs", "create a README from scratch", or anything equivalent — for any repository, language, or framework. The output follows a canonical, customizable template and treats the existing README as a stale snapshot.
---

# README generator

This skill regenerates the root `README.md` so it stays consistent with the actual repository state. The skill is **language- and framework-agnostic**: it inspects the filesystem and configuration files to decide what goes into the README, instead of assuming a specific stack.

## When to load

Trigger this skill when the user asks any of:

- "Genera el README", "actualiza el README", "regenera la documentación".
- "Update project docs", "refresh README", "regenerate README", "create README from scratch".
- After adding/removing/renaming top-level modules, services, packages, or scripts.

Do **not** load it for documenting individual files, JSDoc/TSDoc, API references, or per-package READMEs — only for the root `README.md`.

## How to apply — step-by-step

Always discover state from the filesystem and project manifests. **Never** copy the existing README content blindly; treat it as a stale snapshot.

### 1. Detect the project type

Inspect manifests in this order and pick the first match (a project may have several — keep them all):

| Manifest | Stack hint |
|----------|-----------|
| `package.json` | Node.js / TypeScript / JavaScript |
| `pnpm-workspace.yaml`, `lerna.json`, `turbo.json`, `nx.json` | JS monorepo |
| `pyproject.toml`, `setup.py`, `requirements.txt`, `Pipfile` | Python |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `pom.xml`, `build.gradle(.kts)` | Java / Kotlin (Maven / Gradle) |
| `composer.json` | PHP |
| `Gemfile` | Ruby |
| `mix.exs` | Elixir |
| `pubspec.yaml` | Dart / Flutter |
| `Makefile`, `Justfile`, `Taskfile.yml` | Build orchestration |
| `Dockerfile`, `docker-compose*.yml` | Containerization |
| `serverless.yml`, `samconfig.toml`, `cdk.json`, `terraform/`, `*.tf` | IaC / serverless |

Also read `.nvmrc`, `.tool-versions`, `.python-version`, `rust-toolchain.toml`, `.ruby-version`, etc., to extract concrete runtime versions.

### 2. Map the repo layout

List the top-level directories. Promote any of these to first-class sections of the README **only if they exist** (do not invent):

- Application/service folders: `apps/`, `services/`, `cmd/`, `bin/`, `functions/`.
- Shared code: `libs/`, `lib/`, `packages/`, `internal/`, `pkg/`, `crates/`, `modules/`.
- Cross-cutting code: `shared/`, `common/`, `core/`.
- Config / infra: `config/`, `infra/`, `terraform/`, `cdk/`, `helm/`, `k8s/`.
- Data / schema: `prisma/`, `migrations/`, `db/`, `schema/`.
- Frontend assets: `public/`, `assets/`, `static/`.
- Generated code: `generated/`, `gen/`, `__generated__/`.
- Docs / examples / scripts: `docs/`, `examples/`, `scripts/`.
- Tests: `test/`, `tests/`, `e2e/`.

Each first-class folder will become one bullet in the project structure tree, with a one-line Spanish or English description (match the language of the existing README; if absent, ask the user once and remember the choice).

### 3. Extract scripts / commands

Pull the runnable entry points relevant to developers:

- Node: `package.json#scripts` — group by prefix (`dev:*`, `build:*`, `test:*`, `lint:*`, `deploy:*`, `db:*` / `prisma:*`, etc.).
- Python: tasks defined in `pyproject.toml` (`tool.poetry.scripts`, `tool.hatch.envs.*`), `Makefile` targets, `tox.ini` envs.
- Go: `make` targets, `task` targets.
- Rust: `cargo` aliases (`.cargo/config.toml`).
- Generic: `Makefile`, `Justfile`, `Taskfile.yml` targets.

For each group, render a code block of `$ <invocation>   # short description`. Sort within each group; keep group order consistent run-to-run.

### 4. Render the README

Use `templates/README.template.md` as the layout skeleton. It is intentionally generic — placeholders are filled from steps 1-3:

- `{{PROJECT_NAME}}` — repo name (from manifest, fallback to directory name).
- `{{PROJECT_TAGLINE}}` — one-line description if available in manifest (`description` field), else omit.
- `{{REQUIREMENTS_LIST}}` — bullet per detected runtime/CLI with version + badge.
- `{{TECH_STACK}}` — bullet list of detected frameworks/libs (from manifests).
- `{{COMPONENTS_LIST}}` — bullet list of services/packages/modules discovered in step 2 (omit the whole section if none).
- `{{INSTALLATION_BLOCK}}` — install command(s) for the detected package manager(s).
- `{{ENVIRONMENT_BLOCK}}` — note about copying `.env.example` → `.env` if such file exists; otherwise omit.
- `{{DATABASE_BLOCK}}` — db setup commands if a schema/migration tool is detected; else omit.
- `{{RUN_COMMANDS_BLOCK}}` — grouped scripts from step 3.
- `{{DEPLOYMENT_BLOCK}}` — deploy commands if a CI manifest or `deploy*` script exists; else omit the section.
- `{{PROJECT_TREE}}` — generated tree using the folders found in step 2 (one comment per folder).

Section emojis (🛠️, 🔧, 📱, 🚀, 📂, etc.) are part of the canonical template — keep them. The header `<p align="center">` logo block is **optional**: include it only if a logo URL is provided in the manifest, otherwise drop it.

### 5. Validate before writing

Before writing `README.md`:

- Every detected component (service/package/module) appears exactly once in the components list and once in the tree.
- No script group renders an empty code block.
- No placeholder remains unsubstituted (`{{...}}`).
- Diff against the existing `README.md`: if a hand-written section (badges, sponsors, FAQs, contributing notes) would disappear, **stop and ask** the user whether to keep it.

### 6. Write the file

Overwrite `README.md` at the repo root. Preserve user-authored sections you flagged in step 5; everything else is replaced from the template.

### 7. Report

After writing, output a short summary:

- Detected stacks (e.g. "Node 24 + Prisma + Serverless v3").
- Components / scripts added or removed vs. the previous README.
- Any folder or script that fell back to inferred descriptions, so the user can refine them.

## Hard rules

- **Never** invent components, scripts, or runtime versions that aren't backed by a real file.
- **Never** add per-package READMEs as a side effect.
- **Never** delete or rename hand-written top-level sections without user confirmation.
- **Never** hardcode the components list — always read from the filesystem.
- The output is `README.md` only. Do not touch other docs (`CONTRIBUTING.md`, `CHANGELOG.md`, agent instruction files like `CLAUDE.md` / `AGENTS.md`, etc.).

## Files

- `templates/README.template.md` — generic skeleton with `{{placeholders}}`.
- `templates/section-recipes.md` — how to render each optional section (requirements badges, run commands, project tree).
