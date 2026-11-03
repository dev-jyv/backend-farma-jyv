# 01 — Module structure

Every reusable module lives in `modules/<name>/` and contains exactly four files. No more, no less.

## Required files

```
modules/<name>/
├── main.tf        # Module resources + locals
├── variables.tf   # Variables with description, type and validations
├── outputs.tf     # Exported values
└── versions.tf    # Terraform and provider constraints
```

No READMEs or additional files are created unless the user explicitly requests them.

## main.tf

Always starts with the `locals` block:

```hcl
locals {
  name_prefix = "${var.project_name}-${var.environment}"

  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
    },
    var.tags,
  )
}
```

Resources go after the locals. No resources outside the module are placed in the file (external data sources go in `data.tf` only if there are more than three).

## variables.tf

Every variable carries `description` and `type`. Lists or maps that must stay aligned with another variable carry a `validation` block:

```hcl
variable "project_name" {
  description = "Project identifier used as a prefix for resource names and tags."
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod) used in naming and tagging."
  type        = string
}

variable "tags" {
  description = "Additional tags merged onto every resource created by this module."
  type        = map(string)
  default     = {}
}
```

The `project_name`, `environment` and `tags` variables are **mandatory in every module**.

## outputs.tf

Outputs carry `description`. Lists derived from `for_each` are ordered with `sort(keys(...))` so they are deterministic across runs:

```hcl
output "subnet_ids" {
  description = "Subnet IDs ordered by AZ index."
  value       = [for k in sort(keys(aws_subnet.this)) : aws_subnet.this[k].id]
}
```

## versions.tf

```hcl
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
```

No `provider` block is included in the module — only in the environment's root module.

## Anti-patterns

```hcl
# ❌ Reusable logic as a loose resource in the root module (belongs in a module).
#    Legitimate exception: wiring/glue between modules in the environment's main.tf (rule 02).
resource "aws_security_group" "this" { ... }

# ❌ Unordered output in for_each
value = [for k, v in aws_subnet.this : v.id]

# ❌ Variable without description
variable "vpc_id" {
  type = string
}
```
