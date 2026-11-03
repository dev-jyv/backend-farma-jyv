# 03 — Resource naming

## General pattern

```
{project_name}-{environment}-{resource_type}[-{suffix}]
```

The base prefix is always built as a local in `main.tf`:

```hcl
locals {
  name_prefix = "${var.project_name}-${var.environment}"
}
```

And it is applied in the `Name` tag of each resource:

```hcl
tags = merge(local.common_tags, {
  Name = "${local.name_prefix}-<type>"
})
```

## Suffixes by resource type

| Resource | Suffix | Example |
|---------|--------|---------|
| VPC | `-vpc` | `{project}-dev-vpc` |
| Internet Gateway | `-igw` | `{project}-dev-igw` |
| Subnet with AZ | `-{tier}-{az}` | `{project}-dev-public-us-east-1a` |
| NAT Gateway | `-nat-{idx}` | `{project}-dev-nat-0` |
| Elastic IP | `-nat-eip-{idx}` | `{project}-dev-nat-eip-0` |
| Route table | `-{tier}-rt` | `{project}-dev-private-rt` |
| Security Group | `-{name}-sg` | `{project}-dev-alb-sg` |
| ALB | `-{name}-alb` | `{project}-dev-public-alb` |
| EKS Cluster | `-{name}-eks` | `{project}-dev-eks` |
| RDS | `-{name}-rds` | `{project}-dev-rds` |

## Rules

1. Everything in lowercase, separated by hyphens (`-`). No underscores, no uppercase.
2. The AZ is written in full (e.g. `us-east-1a`), never abbreviated (e.g. `1a`).
3. NAT GW indices are written as strings (`"0"`, `"1"`) because they are `for_each` keys.
4. The `-sg` suffix always goes at the end for security groups, even when they have a descriptive name.

## Anti-patterns

```hcl
# ❌ Underscores
Name = "${local.name_prefix}_vpc"

# ❌ Abbreviated AZ
Name = "${local.name_prefix}-public-1a"

# ❌ No name_prefix — hardcoded
Name = "my-project-dev-vpc"

# ❌ Uppercase
Name = "${local.name_prefix}-ALB"
```
