# 08 — Security and Well-Architected (non-negotiable baseline)

This baseline applies to **every** project and **every** application layer. These are the
minimums; a module that does not meet them is not considered done. It aligns with the
Security, Reliability, and Cost Optimization pillars of the AWS
Well-Architected Framework.

## 1. Private network by default

- Application compute and data live in `private`/`data` subnets, **never**
  `public` (rule 06). The only thing public is the edge (ALB/CloudFront/bastion).
- Data stores: `publicly_accessible = false`, with no inbound route from
  the internet, reachable only via SG-ref from the app (rule 07).
- Internet exposure always through a controlled edge (ALB + WAF,
  or CloudFront with OAC), never exposing the compute or the bucket directly.

## 2. Encryption at rest — always

```hcl
# RDS / Aurora
storage_encrypted = true
storage_type      = "gp3"

# S3
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}
```

Also applies to ElastiCache (`at_rest_encryption_enabled`), EBS, and the state
bucket. Encryption in transit (TLS) wherever the service supports it (`require_tls` in
RDS Proxy, `transit_encryption_enabled` in ElastiCache, `redirect-to-https` in
CloudFront).

## 3. S3 — public access block is mandatory

Every bucket carries its `aws_s3_bucket_public_access_block` with all four flags set to
`true`. Access is granted via a **policy targeted at a principal/service**, not by
opening up the bucket:

```hcl
resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

To serve public assets: **CloudFront + OAC** with the bucket policy scoped to the
`cloudfront.amazonaws.com` principal and an `AWS:SourceArn` condition tied to that
distribution — the bucket stays private. Isolate sensitive content by prefix
(`origin_path = "/public"` + a policy scoped to `arn/public/*`), so that the
private prefix is unreachable by the CDN.

## 4. Secrets — never in code or in variables

- Credentials are **generated** (`random_password`) and stored in **Secrets
  Manager**; they are never hardcoded nor passed through `terraform.tfvars`.
- Store the secret as JSON (host, port, dbname, username, password) so that
  the consumer references individual keys.
- Exclude characters that break connection strings when generating the password
  (`@`, `/`, `"`, space).
- Whoever consumes the secret receives **only its ARN** and is granted `GetSecretValue`
  scoped to that ARN (see point 5).

```hcl
resource "random_password" "master" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}
```

### 4a. `secrets` module — provided vs generated (map-driven)

A reusable `secrets` module models each secret with two kinds of key:
`generated_keys` (Terraform generates them with `random_password` — JWT, internal
API keys) and `values` (provided text — third-party credentials). It stores each
secret as JSON with one key per value, and exposes an output **ready to be
consumed** by the compute (one `{ name, valueFrom }` entry per JSON key):

```hcl
module "secrets" {
  source       = "../../modules/secrets"
  project_name = var.project_name
  environment  = var.environment

  secrets = {
    jwt   = { description = "JWT signing secret.", generated_keys = ["JWT_SECRET"] }
    email = { description = "SMTP creds.", values = { EMAIL_USER = var.email_user, EMAIL_PASS = var.email_pass } }
  }
  tags = var.tags
}
# module.secrets.ecs_secrets  ->  [{ name = "JWT_SECRET", valueFrom = "<arn>:JWT_SECRET::" }, ...]
```

Generated values use `special = false` (alphanumeric) so as not to break
any consumer that parses the string.

### 4b. Sensitive inputs: secrets.auto.tfvars gitignored

**Sensitive input values** (those that feed the `values` of the `secrets`
module) never go in the versioned `terraform.tfvars`. They are passed through a
`*.auto.tfvars` file (which Terraform loads on its own) that is in `.gitignore`, or
through `TF_VAR_*` variables. A `.example` **template** with placeholders is versioned:

```
environments/<env>/
├── terraform.tfvars              # NON-sensitive values (versioned)
├── secrets.auto.tfvars           # real sensitive values (GITIGNORED)
└── secrets.auto.tfvars.example   # template with placeholders (versioned)
```

```gitignore
# repo .gitignore
*.auto.tfvars
*.auto.tfvars.json
```

The variable that receives the sensitive value is marked `sensitive = true` in
`variables.tf`. Rule: if a value is a secret, it comes in through `*.auto.tfvars`/`TF_VAR_`
→ it is stored in Secrets Manager → the compute reads it from there. It **never** transits
through a versioned file nor through plaintext env vars in the container.

## 5. Least-privilege IAM

- One role per execution identity; policies scoped to the **specific resource**
  (ARN of the secret, the bucket, the topic), not `Resource = "*"` except when the
  service requires it (e.g. `kms:Decrypt`), and then **with a condition**:

```hcl
statement {
  actions   = ["kms:Decrypt"]
  resources = ["*"]
  condition {
    test     = "StringEquals"
    variable = "kms:ViaService"
    values   = ["secretsmanager.${data.aws_region.current.name}.amazonaws.com"]
  }
}
```

- Separate the *execution/platform* role (pulling images, logs, reading secrets)
  from the *runtime application* role (access to S3, SNS, etc.). The runtime one
  starts **with no policies**; explicit permissions are attached to it per use case.
- Policies are built with `data "aws_iam_policy_document"`, not hand-written JSON.

## 6. Operational access via bastion, not by exposing the DB

Administrative access to the database is done through an SSH tunnel to a **bastion** in the
public layer; the DB never receives a public IP. The bastion adds its own ingress rule
to the DB's SG (rule 07). In prod, restrict the bastion's SSH to the
corporate/VPN CIDR.

## 7. Data protection in prod

```hcl
deletion_protection     = true    # prod
skip_final_snapshot     = false   # prod: keeps a snapshot on destroy
backup_retention_period = 30      # prod (dev: 1)
```

Consider `lifecycle { prevent_destroy = true }` on stateful resources (RDS,
buckets with data) where applicable (rule 05). In dev these values are relaxed
to allow iterating without cost.

## 8. Secure state

The state bucket is encrypted, versioned, and has a full `public_access_block`,
with locking (`use_lockfile`) to prevent concurrent applies (rule 02).

## 9. Traceability

- `default_tags` + `common_tags` guarantee `Project`/`Environment`/`ManagedBy`
  on every resource (rule 04): the basis for cost allocation and auditing.
- Enable logging wherever it exists (WAF logging, ALB access logs, CloudFront logs,
  proxy `debug_logging` only for pinpoint diagnostics).

## Quick checklist before considering a module done

- [ ] Is the component in the correct layer (data/private/public)?
- [ ] Is encryption at rest enabled? Is TLS in transit enabled if applicable?
- [ ] Is no resource with data `publicly_accessible`?
- [ ] Do buckets have a complete `public_access_block`?
- [ ] Are secrets in Secrets Manager, not in variables or code?
- [ ] Is IAM scoped to specific ARNs (or with a condition if it is `*`)?
- [ ] Is internal ingress via SG-ref, not via CIDR?
- [ ] Are `deletion_protection`/backups configured according to environment?
