# 10 — Environment documentation (README.md)

Every environment in `environments/<env>/` carries a `README.md` that documents **what
gets deployed and how to operate it**. It is a deliverable, not optional: it is created
when the environment is born and is **updated in the same change** that adds/removes
modules or resources (an outdated README is worse than not having one).

> Scope: this rule applies to **environment** READMEs. Modules do **not** carry a
> README by default (rule 01) unless the user requests one.

## Principle: real values, not placeholders

The README describes the **concrete** state of that environment. Extract the values from
the repo itself before writing — never make them up:

- region, account, `project_name`, `environment`, CIDRs, sizes → `terraform.tfvars`
- active modules and standalone resources → `main.tf`
- output names for the command examples → `outputs.tf`
- state key and locking type → `versions.tf`

Every command example uses `terraform output <real_name>` so that copy-paste works.
Do not hardcode endpoints/IPs that are only known after `apply`.

## Structure (in this order)

### 1. Title and introduction
`# Environment <env>` + 2-3 lines: what it is (root module of `<project>`), what it
deploys, region and account, and **the type of application layer** (serverless /
containers / etc. — the dynamic part, rule 09).

### 2. Differences from another environment — *only if derived from one*
When the environment is based on another (e.g., `prod` derives from `dev`), a
`| Area | <base> | <this> |` table with the differences (CIDR, NAT, instance sizes,
backups, `deletion_protection`, repo naming). Add `>` notes for deliberate decisions
(e.g., why Multi-AZ is still `false`).

### 3. Architecture (ASCII diagram)
A diagram showing the **three layers** (rule 06) and the traffic flow. Convention:

```
                              Internet / SSH:22
                                  │
┌── AWS Cloud · <region> · Account <acct> · VPC <cidr> ────────────────────┐
├── PUBLIC SUBNETS ─────────────────────────────────────────────────────────┤
│   Edge/access: ALB or bastion (depending on app layer)                    │
├── PRIVATE SUBNETS ────────────────────────────────────────────────────────┤
│   Application layer (Lambda / Fargate / EC2) · SG app  ──:port──┐         │
├── DATA SUBNETS ────────────────────────────────────────────────────┼──────┤
│   RDS Proxy → RDS · cache · (never public)                         ◄┘      │
├── AWS Services ───────────────────────────────────────────────────────────┤
│   Secrets Manager · SNS · S3 · CloudFront · ECR (whichever apply)         │
└────────────────────────────────────────────────────────────────────────────┘

Terraform backend (remote state):
  S3  <bucket>  (versioned + encrypted)  ·  key <env>/terraform.tfstate
  Native S3 locking (use_lockfile) — no DynamoDB
```

Adjust the edge and the private layer to the actual runtime: bastion+Lambdas for
serverless; ALB→ECS for Fargate. Annotate the real ports and CIDRs of each layer/AZ.

### 4. Active modules
A `| Module | Description |` table with **only the modules this environment invokes**
(not those that exist in `modules/` but are not used here). Description with the
concrete values of the environment.

### 5. Standalone resources (in `main.tf`)
A `| Resource | Description |` table with the environment's glue/wiring (app SG,
buckets, CloudFront, policies). See rule 02.

### 6. Addressing plan — *optional, useful in large VPCs*
A `| Layer | AZ-a | AZ-b |` table with the CIDRs per layer/AZ and the range reserved for
growth.

### 7. Remote state (S3 backend)
The basic flow (`cd environments/<env>` → `init` → `plan` → `apply`), the state key,
and the note that provider/backend **do not pin a `profile`** (default credential chain
→ point at the correct account).

### 8. Per-component sections (whichever apply)
One subsection per present component, each with **how to operate it** and
`terraform output` commands. Include only the ones that exist in the environment:

- **Operational access (bastion / SSH key pair):** create the key pair, connect,
  validate the DB. In prod, remember to restrict `ssh_cidr` to the corporate/VPN CIDR.
- **RDS Proxy / database:** how it authenticates (Secrets Manager), who can reach it
  (source→route→SG rule table), TLS.
- **Connect the app to the DB:** SG to assign, private subnets, the **proxy** endpoint
  (not the instance), where the credentials come from.
- **SNS / queues:** topics and how to wire subscriptions.
- **S3 / CloudFront:** bucket naming, public block, and the public/private isolation
  pattern per prefix (OAC) if applicable.
- **ECR:** repo naming (shared vs per-environment), login/build/push.

## When to update it

Regenerate or edit the environment README in the same change that:
- adds/removes a module or standalone resource,
- changes a value that is visible in the docs (size, CIDR, naming, retention),
- changes the application layer runtime (serverless ↔ containers).

## Anti-patterns

- ❌ Placeholders or made-up values instead of reading `tfvars`/`outputs`.
- ❌ Documenting modules that exist in `modules/` but that the environment does not invoke.
- ❌ Hardcoding post-apply endpoints/IPs instead of `terraform output`.
- ❌ Copying another environment's README without adjusting values (CIDR, account, sizes).
- ❌ Leaving the README out of sync with `main.tf` after a change.
