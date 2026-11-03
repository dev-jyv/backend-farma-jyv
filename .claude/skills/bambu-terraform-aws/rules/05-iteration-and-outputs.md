# 05 — Iteration and outputs

## `for_each` vs `count`

| Case | Use |
|------|------|
| Resource that can scale (subnets, SGs per tier, nodes) | `for_each` with a stable key |
| Boolean resource (exists / does not exist) | `count = var.enable_x ? 1 : 0` |
| Single resource with no variation | Simple block without a meta-argument |

### Why `for_each` over `count` for scalable resources

With `count`, Terraform identifies resources by integer index. Adding or removing an element from the middle shifts all subsequent indices, forcing cascading recreation. With `for_each` and stable keys, each resource has its own identity.

### `for_each` pattern with a map indexed by AZ

```hcl
locals {
  public_subnets = {
    for idx, cidr in var.public_subnet_cidrs :
    idx => { cidr = cidr, az = var.azs[idx] }
  }
}

resource "aws_subnet" "public" {
  for_each = local.public_subnets

  cidr_block        = each.value.cidr
  availability_zone = each.value.az
  # ...
}
```

The keys are integer indices (`0`, `1`) but are implicitly converted to strings by Terraform. For resources where an explicit string is required (NAT GW, EIP):

```hcl
resource "aws_nat_gateway" "this" {
  for_each = toset([for k in local.nat_gateway_keys : tostring(k)])
  # ...
}
```

## List outputs — always ordered

Resources created with `for_each` produce a map, not a list. When exporting them as a list, sort by key to guarantee that the output is deterministic across runs and refactorings:

```hcl
# ✅ Correct — ordered
output "public_subnet_ids" {
  description = "Public subnet IDs ordered by AZ index."
  value       = [for k in sort(keys(aws_subnet.public)) : aws_subnet.public[k].id]
}

# ❌ Incorrect — indeterminate order
output "public_subnet_ids" {
  value = [for k, v in aws_subnet.public : v.id]
}

# ❌ Also incorrect — values() does not guarantee order
output "public_subnet_ids" {
  value = values(aws_subnet.public)[*].id
}
```

## Optional outputs (conditional resource with `count`)

When a resource uses `count`, the output can be `null` if it was not created:

```hcl
output "nat_gateway_id" {
  description = "ID of the primary NAT Gateway, or null when NAT is disabled."
  value       = local.nat_enabled ? aws_nat_gateway.this["0"].id : null
}
```

## Optional modules (environment-level toggle)

An entire module can be enabled/disabled from the environment with
`count = var.flag ? 1 : 0` on the `module` block. Useful for optional parts
of the stack (WAF, ACM/HTTPS, a CDN). When referencing their outputs you index `[0]`, and
the wiring in other modules is made conditional:

```hcl
# The ACM certificate only exists if a domain was configured.
module "acm" {
  count       = var.domain_name != "" ? 1 : 0
  source      = "../../modules/acm"
  domain_name = var.domain_name
  # ...
}

module "waf" {
  count        = var.waf_enabled ? 1 : 0
  source       = "../../modules/waf"
  resource_arn = module.alb.alb_arn
  # ...
}

module "alb" {
  source          = "../../modules/alb"
  certificate_arn = var.domain_name != "" ? module.acm[0].certificate_arn : ""
  # ...
}
```

This way a single environment definition serves multiple variants (with/without HTTPS, with/without
WAF) without duplicating code; the variant is chosen in `terraform.tfvars`.

## Explicit `depends_on`

Only when Terraform cannot infer the dependency from references (rare). A typical example: EIP and NAT GW depend on the IGW being attached before they are created.

```hcl
resource "aws_nat_gateway" "this" {
  # ...
  depends_on = [aws_internet_gateway.this]
}
```

Do not use `depends_on` in modules that consume other modules — always reference the output directly (`module.vpc.vpc_id`) so that Terraform infers the dependency.

## `lifecycle` blocks

Use when the resource has external state that Terraform must not destroy on change:

```hcl
lifecycle {
  prevent_destroy = true  # RDS, S3 buckets with data
}

lifecycle {
  ignore_changes = [engine_version]  # RDS minor version auto-upgrade
}
```

Do not add `lifecycle` by default — only when there is a concrete reason.
