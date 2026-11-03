# Section recipes

How to fill each placeholder in `README.template.md`. Apply only the recipes whose source data exists — every section is **conditionally rendered**.

---

## `{{LOGO_BLOCK}}`

If the project's manifest provides a logo URL (e.g. `package.json#homepage` + a known logo, framework logo such as NestJS / Vue / Django, or `assets/logo.*`), render:

```html
<p align="center">
  <a href="{{HOMEPAGE_URL}}" target="blank"><img src="{{LOGO_URL}}" width="200" alt="{{PROJECT_NAME}} Logo" /></a>
</p>
```

Otherwise leave the placeholder empty (drop the line).

---

## `{{PROJECT_NAME}}`

Order of precedence:

1. `name` field of the project manifest (`package.json`, `pyproject.toml#project.name`, `Cargo.toml#package.name`, `go.mod` module name's last segment, etc.).
2. The repo directory name.

Optionally prefix with one emoji if the existing README already uses one in the title.

## `{{PROJECT_TAGLINE}}`

A single sentence — pull from manifest `description` field, or omit the line entirely if absent.

---

## `{{REQUIREMENTS_LIST}}`

One bullet per detected runtime/CLI. Use `img.shields.io` badges for visual consistency, but only when a concrete version is known. Examples:

```markdown
- ![NodeJS](https://img.shields.io/badge/NodeJS-{{VERSION}}-green?logo=nodedotjs&logoColor=white) Node.js v{{MAJOR}}
- ![Python](https://img.shields.io/badge/Python-{{VERSION}}-blue?logo=python&logoColor=white) Python {{MAJOR_MINOR}}
- ![Go](https://img.shields.io/badge/Go-{{VERSION}}-cyan?logo=go&logoColor=white) Go {{MAJOR_MINOR}}
- ![Rust](https://img.shields.io/badge/Rust-{{VERSION}}-orange?logo=rust&logoColor=white) Rust {{VERSION}}
- ![Docker](https://img.shields.io/badge/Docker-blue?logo=docker&logoColor=white) Docker
```

Only include CLIs that the project actually requires (look for them in scripts, lockfiles, or CI manifests).

---

## `{{TECH_STACK}}`

Render `### Core Technologies` followed by a bullet list. Each bullet: `- **Role**: Name {{version}} - short purpose`.

Examples of roles to look for, depending on dependencies found:
- Framework, language, ORM, database, cache, message broker
- Auth provider, cloud provider(s)
- Build tool, test runner
- Deployment / IaC tool

Skip roles for which there is no detected dependency.

---

## `{{COMPONENTS_LIST}}`

If the repo has any of `apps/`, `services/`, `packages/`, `libs/`, `cmd/`, `functions/`, `modules/`, render a section like:

```markdown
This monorepo contains the following {{COMPONENT_KIND}}:

- **{{name}}** - {{one-line description}}
- ...
```

Where `{{COMPONENT_KIND}}` is "microservices", "packages", "modules", "binaries", etc. — whichever fits the detected folder.

Sort alphabetically. If no such folder exists, **omit the entire section** (drop both the heading and placeholder).

For each component, infer the description from:
1. The manifest inside the component (`package.json#description`, `pyproject.toml#project.description`, doc-comments at top of `main.go`, etc.).
2. The component's main module/controller name and routes if (1) is empty.

If a description can't be inferred confidently, mark it `<!-- TODO: describe {{name}} -->` and report it back to the user.

---

## `{{INSTALLATION_BLOCK}}`

Render the install command(s) for each detected package manager:

| Manager | Install command |
|---------|----------------|
| npm | `$ npm ci` (or `$ npm install` if no lockfile) |
| pnpm | `$ pnpm install --frozen-lockfile` |
| yarn | `$ yarn install --frozen-lockfile` |
| bun | `$ bun install` |
| pip + requirements | `$ pip install -r requirements.txt` |
| poetry | `$ poetry install` |
| uv | `$ uv sync` |
| go | `$ go mod download` |
| cargo | `$ cargo build` |
| composer | `$ composer install` |
| bundler | `$ bundle install` |

Prepend any required global CLIs (`npm i -g <cli>`) only when their config file is present (e.g. `serverless.yml` ⇒ `npm i -g serverless@<major>`; `nest-cli.json` ⇒ `npm i -g @nestjs/cli`).

---

## `{{ENVIRONMENT_BLOCK}}`

If `.env.example` (or `.env.sample`, `.env.template`) exists:

```markdown
Copy `.env.example` to `.env` and fill in the required values.
```

Otherwise omit the **section** entirely (delete heading + placeholder).

---

## `{{DATABASE_BLOCK}}`

Detect a database tool and render its setup commands:

- **Prisma** (`prisma/schema.prisma`):

  ```bash
  $ {{PM}} run prisma:generate
  $ {{PM}} run prisma:migrate
  $ {{PM}} run prisma:db:seed
  ```

- **TypeORM**, **Drizzle**, **Knex**, **Sequelize**: respective generate / migrate scripts.
- **Django** (`manage.py`): `$ python manage.py migrate`.
- **Alembic** (`alembic.ini`): `$ alembic upgrade head`.
- **Flyway / Liquibase**: their migrate command.
- **golang-migrate** (`migrations/*.sql` + tool config): `$ migrate -path migrations -database "$DB_URL" up`.

If a `docker-compose*.yml` exposes a db service for local dev, prepend:

```bash
$ docker compose -f {{compose-file}} up -d {{db-service}}
```

If no DB tooling is detected, omit the section.

---

## `{{RUN_COMMANDS_BLOCK}}`

Render one fenced code block per script group, preceded by a `### {{Group Title}}` heading. Group by prefix (`dev:`, `build:`, `test:`, `lint:`, `deploy:`, `db:` / `prisma:`, `email:`, etc.) for npm-style scripts, or by section for Make/Just/Task targets.

Each line: `$ <invocation>{{padding}}# {{description}}` — pad invocations so all `#` start at the same column inside a block.

Sort entries inside a block alphabetically. Omit a group if it has no scripts.

---

## `{{DEPLOYMENT_BLOCK}}`

Include this section only if at least one of these is detected:

- A CI manifest: `.github/workflows/`, `buildspec*.yml`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/`.
- A deploy script: `deploy.sh`, `Makefile` deploy target, `package.json` `deploy:*` scripts.
- IaC tooling: `serverless.yml`, `cdk.json`, `*.tf`, `samconfig.toml`, `helm/`.

Render two subsections **only when applicable**:

- `### Automatic Deployment (CI/CD)` — describe which branch deploys to which environment, with a one-line summary of the pipeline (build → push → migrate → deploy).
- `### Manual Deployment` — show the actual command(s) to run.

If none of the above are detected, omit the entire section.

---

## `{{PROJECT_TREE}}`

Generate the tree using only directories that exist. Format rules:

- Use `├── ` for every entry except the last sibling, which uses `└── `.
- Always end directory names with `/`.
- Pad names so the trailing `# comment` aligns vertically (column 36 is a good default).
- Comments use the dominant language of the existing README (Spanish or English). If unknown, default to English.
- Two levels deep at most for `apps/`, `libs/`, `packages/`, etc. (one bullet per child).
- Top-level files: include only the load-bearing ones (`package.json`, `tsconfig.json`, `Dockerfile`, `docker-compose*.yml`, `serverless.yml`, `Makefile`, `pyproject.toml`, etc.).

Skeleton:

```text
{{REPO_NAME}}/
├── {{TOP_LEVEL_DIR}}/              # {{description}}
│   ├── {{child}}/                  # {{description}}
│   └── ...
├── ...
└── {{LAST_TOP_LEVEL_FILE}}         # {{description}}
```
