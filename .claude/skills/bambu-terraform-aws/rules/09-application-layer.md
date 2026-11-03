# 09 — Application layer (the dynamic part)

The foundation (3-tier VPC, private RDS, tags, state, security) is **the same in every
project**. What changes between projects —and can change within the same
project over time— is **how the application code runs**: Lambda today,
Fargate tomorrow, EC2 or EKS in another. This rule defines the contract that any
application layer must satisfy to plug into the common foundation.

## The contract: what ANY app layer must satisfy

Regardless of the chosen runtime, the application layer:

1. **Runs in the `private` tier** (never `public`). Public access enters through
   the edge (ALB/CloudFront), not through the compute.
2. **Has its own SG** (`{prefix}-app-sg` or `{prefix}-<service>-sg`).
3. **Reaches the data via SG-ref**: its SG is the `allowed_security_group_id` /
   `app_sg_id` consumed by the data modules (RDS Proxy, ElastiCache).
   It never connects to the RDS instance directly — always to the **proxy/endpoint**.
4. **Reads sensitive configuration from Secrets Manager** with an IAM role scoped
   to the secret's ARN (rule 08), not from plaintext environment variables.
5. **Egresses to the internet via NAT** (image/package pulls, AWS APIs), with no
   inbound route from the internet.
6. Is **wired in the environment's `main.tf`**, passing the foundation's outputs
   (`module.vpc.private_subnet_ids`, `module.rds_proxy.proxy_endpoint`, the SG).

As long as this contract is met, the runtime is interchangeable.

## How to choose the runtime

| Need | Runtime | Typical module(s) |
|------|---------|-------------------|
| Event-driven, bursty, scale to zero, low management | **Lambda** (serverless) | lambda SG (glue) + functions (outside IaC or `lambda` module) |
| Long-running HTTP service, containers, no server management | **Fargate** | `ecs` + `alb` + `security-groups` |
| OS control / special workloads / legacy software | **EC2 / ASG** | `ec2-asg` + `alb` |
| Complex container orchestration, multi-service | **EKS** | `eks` + `alb` (controller) |

> If the user doesn't specify it, **ask** which runtime before generating. Don't
> assume Lambda just because the reference project uses it.

## Pattern A — Serverless (Lambda)

The function(s) are usually created outside this IaC (or in a `lambda` module), but
the infrastructure they need is defined here. The "compute SG" is a glue resource
in `main.tf` with **egress only**; ingress to the proxy is granted by the proxy
referencing this SG.

```hcl
# Glue in main.tf: SG for the Lambdas in the VPC (egress only).
resource "aws_security_group" "lambda" {
  name        = "${var.project_name}-${var.environment}-lambda-sg"
  description = "Serverless functions: outbound to RDS Proxy and AWS APIs."
  vpc_id      = module.vpc.vpc_id
  tags        = merge(var.tags, { Name = "${var.project_name}-${var.environment}-lambda-sg" })
}

resource "aws_vpc_security_group_egress_rule" "lambda_all" {
  security_group_id = aws_security_group.lambda.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Outbound to RDS Proxy, Secrets Manager, SNS, etc."
}

# The proxy accepts this SG (the data module consumes the app's SG).
module "rds_proxy" {
  source                     = "../../modules/rds-proxy"
  # ...
  allowed_security_group_ids = [aws_security_group.lambda.id]
}
```

The Lambdas are deployed into `module.vpc.private_subnet_ids` with `aws_security_group.lambda.id`.

## Pattern B — Containers (Fargate)

The edge is an ALB in the `public` tier; the service runs in `private`. The
`security-groups` module models the ALB→ECS chain and the `rds`/`rds-proxy` module accepts the
ECS SG.

```hcl
module "security_groups" { source = "../../modules/security-groups"; vpc_id = module.vpc.vpc_id; container_port = var.container_port; /* ... */ }
module "alb"             { source = "../../modules/alb"; subnets = module.vpc.public_subnet_ids;  security_group_id = module.security_groups.alb_sg_id; /* ... */ }
module "ecs"             { source = "../../modules/ecs"; subnets = module.vpc.private_subnet_ids; security_group_id = module.security_groups.ecs_sg_id; /* ... */ }

# The data accepts the compute's SG — same contract as in serverless.
module "rds_proxy" { source = "../../modules/rds-proxy"; allowed_security_group_ids = [module.security_groups.ecs_sg_id]; /* ... */ }
```

Two IAM roles in the container module (rule 08): *execution role* (ECR pull +
logs) and *task role* (runtime, starts empty; permissions are attached per
use case with `aws_iam_role_policy_attachment` in `main.tf`).

## How the compute consumes config and secrets

Whatever the runtime, configuration is **wired from the modules' outputs in
`main.tf`**, not hardcoded. Always separate **non-sensitive** config
(plaintext env vars) from **secrets** (a reference to Secrets Manager, never the value).

**Secrets → reference by JSON key, not the value.** Fargate uses the task
definition's `secrets` block with `valueFrom = "<secret-arn>:<json-key>::"`;
Lambda reads the secret with the SDK at runtime. The ARN **is only known after apply**,
which is why the list is assembled with `locals` in `main.tf`, not in `terraform.tfvars`:

```hcl
locals {
  # One entry per key of the RDS JSON secret (ARN known post-apply).
  rds_secrets = [
    { name = "DB_HOST",     valueFrom = "${module.rds.db_secret_arn}:host::" },
    { name = "DB_PASSWORD", valueFrom = "${module.rds.db_secret_arn}:password::" },
    # ...
  ]
}
```

**Concatenate the secret sources** — managed by the `secrets` module,
auto-wired from the data layer, and external ones referenced by ARN:

```hcl
secrets = concat(
  local.rds_secrets,          # from module.rds (post-apply)
  local.redis_secrets,        # from module.elasticache (post-apply)
  module.secrets.ecs_secrets, # secrets managed by the secrets module
  var.ecs_secrets,            # external secrets, by ARN, from tfvars
)
```

**Non-sensitive config derived from outputs** — so it never drifts from what's
deployed (CloudFront domain, bucket name):

```hcl
locals {
  assets_env = [
    { name = "ASSETS_CDN_BASE_URL",       value = "https://${module.s3_cdn.cloudfront_domain_name}" },
    { name = "AWS_S3_ASSETS_BUCKET_NAME", value = module.s3_cdn.bucket_id },
  ]
}
environment_variables = concat(local.assets_env, var.ecs_environment_variables)
```

**Per-use-case permissions on the runtime role** — the task/execution role starts
empty; permissions are attached in `main.tf` as glue (rule 02/08):

```hcl
resource "aws_iam_role_policy_attachment" "ecs_task_s3" {
  role       = module.ecs.task_role_name
  policy_arn = module.s3_cdn.task_s3_policy_arn
}
```

## Migrating from one runtime to another (Lambda ↔ Fargate)

Since the foundation satisfies a stable contract, migrating means:

1. Add the new runtime's module(s) (`ecs`+`alb`, or the `lambda` SG).
2. Replace the SG passed as `allowed_security_group_ids` to the data modules
   with the new compute's SG.
3. Wire the new edge (ALB) if applicable.
4. Remove the old runtime's glue.

The VPC, subnets, RDS, RDS Proxy, secrets, tags, and state **don't change**.

## Anti-patterns

```hcl
# ❌ Compute in a public subnet "to expose it": the edge is ALB/CloudFront, not the compute
subnets = module.vpc.public_subnet_ids   # for app Fargate/EC2/Lambda: use private

# ❌ App connecting directly to the RDS instance instead of the proxy/endpoint
DB_HOST = module.rds.db_instance_endpoint   # use module.rds_proxy.proxy_endpoint

# ❌ Putting runtime logic inside the VPC/RDS module
#    (the foundation is runtime-agnostic; the runtime is wired in main.tf)

# ❌ DB credentials as plaintext environment variables
environment = { DB_PASSWORD = var.db_password }   # use Secrets Manager + IAM
```
