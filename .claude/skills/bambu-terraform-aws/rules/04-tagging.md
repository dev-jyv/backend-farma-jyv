# 04 — Tagging

The project uses two layers of tags that complement each other. Logic is never duplicated between them.

## Layer 1 — `default_tags` in the provider (environment)

Defined in `environments/<env>/versions.tf`. It is applied automatically to **all** resources in the environment without writing them on each resource:

```hcl
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

## Layer 2 — `common_tags` in the module

Defined in the `locals` of each module. It repeats the three base tags so the module is usable regardless of the environment that consumes it, and merges `var.tags` to allow additional per-environment tags:

```hcl
locals {
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

It is applied on each resource in the module:

```hcl
tags = merge(local.common_tags, {
  Name = "${local.name_prefix}-<type>"
})
```

## `Tier` tag

Resources with a logical layer add the `Tier` tag:

```hcl
# Subnets
tags = merge(local.common_tags, {
  Name = "${local.name_prefix}-public-${each.value.az}"
  Tier = "public"
})

# Route tables
tags = merge(local.common_tags, {
  Name = "${local.name_prefix}-private-rt"
  Tier = "private"
})
```

Valid values for `Tier`: `"public"`, `"private"`, `"data"`.

## Additional per-environment tags (`var.tags`)

Defined in the `terraform.tfvars` of each environment. The concrete values depend on the project:

```hcl
# environments/dev/terraform.tfvars
tags = {
  Owner      = "platform-team"
  CostCenter = "{project}-dev"
}
```

## Final result on a resource (public subnet)

```
Project     = "{project_name}"                  ← default_tags + common_tags
Environment = "dev"                             ← default_tags + common_tags
ManagedBy   = "Terraform"                       ← default_tags + common_tags
Name        = "{project_name}-dev-public-{az}"  ← resource
Tier        = "public"                          ← resource
Owner       = "platform-team"                   ← var.tags
CostCenter  = "{project}-dev"                   ← var.tags
```

## `tags` variable — required in every module

```hcl
variable "tags" {
  description = "Additional tags merged onto every resource created by this module."
  type        = map(string)
  default     = {}
}
```

## Anti-patterns

```hcl
# ❌ Hardcoded tags (not parameterized)
tags = {
  Project     = "my-project"
  Environment = "dev"
}

# ❌ Not merging var.tags — prevents per-environment override
tags = local.common_tags

# ❌ Module without a tags variable
# (there is no way to add tags from the environment)
```
