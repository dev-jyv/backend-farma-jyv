# 02 — Environment structure (root modules)

Each environment is an independent root module in `environments/<env>/`. The typical
scheme is `dev`, `staging`, and `prod`, though it may vary per project. Each
environment has **its own state** — they never share a state file.

## Root module files

```
environments/<env>/
├── main.tf           # Module calls + standalone wiring resources
├── variables.tf      # Environment variables
├── outputs.tf        # Re-exports the relevant module outputs
├── terraform.tfvars  # Concrete environment values
├── versions.tf       # S3 backend + provider configuration
└── README.md         # Environment architecture and operation (rule 10)
```

## Environment versions.tf — S3 backend with native locking

The state is stored in S3 with **native S3 locking** (`use_lockfile = true`),
**without a DynamoDB table** (requires Terraform ≥ 1.11). Bucket versioning
keeps the history of each `apply`. The bucket follows the pattern
`{project_name}-tfstate` and each environment uses a different `key`:

```hcl
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Per-environment state; native S3 locking (no DynamoDB). Requires TF >= 1.11.
  backend "s3" {
    bucket       = "{project_name}-tfstate"
    key          = "<env>/terraform.tfstate"
    region       = "<aws_region>"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}
```

> The provider and the backend **do not set `profile`**: they use AWS's default
> credential chain. The operator is responsible for pointing at the correct account.

### State bucket bootstrap (once per project)

```bash
aws s3api create-bucket --bucket {project_name}-tfstate --region <region> \
  --create-bucket-configuration LocationConstraint=<region>
aws s3api put-bucket-versioning --bucket {project_name}-tfstate \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket {project_name}-tfstate \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket {project_name}-tfstate \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

For a new environment the **same bucket is reused**, changing only the `key`
(e.g. `staging/terraform.tfstate`).

## Environment main.tf — modules + wiring

The environment's `main.tf` contains two things:

1. **Module calls.** `project_name`, `environment`, and `tags` are always passed.
2. **Standalone "glue" resources (wiring between modules).** This is the only
   place where resources outside a module are allowed, and **only** to connect
   modules to each other or resolve dependencies that don't belong to any
   reusable module. Legitimate examples:
   - the application-layer SG (Lambda/Fargate) that other modules reference,
   - an ingress rule that connects two modules,
   - an S3 bucket or CloudFront distribution specific to that project,
   - `data "aws_caller_identity"` / `data "aws_region"` for unique names.

```hcl
module "vpc" {
  source = "../../modules/vpc"

  project_name = var.project_name
  environment  = var.environment
  vpc_cidr     = var.vpc_cidr
  azs          = var.azs

  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  data_subnet_cidrs    = var.data_subnet_cidrs

  enable_nat_gateway = var.enable_nat_gateway
  single_nat_gateway = var.single_nat_gateway

  tags = var.tags
}

# Glue: application-layer SG (dynamic part of the project). See rule 09.
resource "aws_security_group" "app" {
  name        = "${var.project_name}-${var.environment}-app-sg"
  description = "Application compute layer: egress to data/proxy and AWS APIs."
  vpc_id      = module.vpc.vpc_id

  tags = merge(var.tags, {
    Name = "${var.project_name}-${var.environment}-app-sg"
  })
}
```

> **Rule:** reusable logic → module. Environment-specific wiring →
> standalone resource in `main.tf`. Never put reusable business logic as a
> standalone resource, nor environment-specific wiring inside a generic module.

## terraform.tfvars — concrete values and per-environment differences

Each environment defines its values. The `dev` defaults are optimized for cost and
are "flipped" in `prod`:

```hcl
aws_region   = "<region>"
project_name = "<project>"      # the SAME across all environments
environment  = "dev"            # changes per environment

vpc_cidr = "<unique cidr per environment>"   # ranges that don't overlap between envs
azs      = ["<az-a>", "<az-b>"]

public_subnet_cidrs  = ["<cidr-a>", "<cidr-b>"]
private_subnet_cidrs = ["<cidr-a>", "<cidr-b>"]
data_subnet_cidrs    = ["<cidr-a>", "<cidr-b>"]

enable_nat_gateway = true
single_nat_gateway = true    # dev: 1 shared NAT | prod: false (1 per AZ)

tags = {
  Owner      = "<team>"
  CostCenter = "<project>-dev"
}
```

> `terraform.tfvars` is versioned and carries **only non-sensitive values**. Input
> secrets go in a gitignored `secrets.auto.tfvars` (or `TF_VAR_*`),
> with a versioned `.example` template — see [rule 08](08-security-and-well-architected.md#4b-sensitive-inputs-secretsautotfvars-gitignored).

| Setting | dev (cost-optimized) | prod (resilient) |
|--------|----------------------|-------------------|
| `single_nat_gateway` | `true` | `false` |
| Instance sizing | minimal | sized |
| `deletion_protection` (data) | `false` | `true` |
| `skip_final_snapshot` | `true` | `false` |
| Backup retention | short | long |
| VPC CIDR | range A | range B (no overlap) |

## Mandatory variables in every environment

```hcl
variable "aws_region"   { description = "AWS region to deploy into."; type = string }
variable "project_name" { description = "Project identifier used as prefix for names and tags."; type = string }
variable "environment"  { description = "Deployment environment name."; type = string }
variable "tags"         { description = "Additional tags applied to resources."; type = map(string); default = {} }
```
