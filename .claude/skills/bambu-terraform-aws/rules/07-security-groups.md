# 07 — Security groups

Security groups are the **east-west** access control (between components).
The core rule: internal traffic is authorized **by reference to another SG**,
never by CIDR. CIDRs are only used for traffic that genuinely comes from
the internet or from a known external range (corporate VPN).

## One SG per component

Each component has its own dedicated SG, named `{prefix}-{component}-sg`
(rule 03) and tagged with its `Tier` when applicable. SGs are not shared between
different components.

## Rules as separate resources (not inline blocks)

Use `aws_vpc_security_group_ingress_rule` / `aws_vpc_security_group_egress_rule`
(one rule = one resource), **not** the `ingress`/`egress` blocks embedded in
`aws_security_group`. Each rule carries a `description` and its `Name` tag.

```hcl
resource "aws_security_group" "app" {
  name        = "${local.name_prefix}-app-sg"
  description = "Application compute: egress to data tier and AWS APIs."
  vpc_id      = var.vpc_id
  tags = merge(local.common_tags, { Name = "${local.name_prefix}-app-sg" })
}
```

## SG-to-SG reference for internal traffic

The allowed source is expressed with `referenced_security_group_id`, not with
`cidr_ipv4`. This way the permission follows the component even if its IPs change:

```hcl
# ✅ The data store only accepts the app's SG.
resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  description                  = "DB port from the application SG only."
  from_port                    = var.db_port
  to_port                      = var.db_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = var.app_sg_id
}
```

## Cross-module rules: added by the consumer, not the SG owner

When a module B needs to reach a resource in module A, the **ingress rule on
A's SG is created by module B** (receiving `a_sg_id` as a variable). This way
module A stays unmodified and unaware of its clients.

```hcl
# In the bastion module: the bastion adds its OWN rule to the RDS SG.
resource "aws_vpc_security_group_ingress_rule" "rds_from_bastion" {
  security_group_id            = var.rds_sg_id            # SG that belongs to the rds module
  referenced_security_group_id = aws_security_group.bastion.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from bastion host."
}
```

Equivalent pattern for client lists (several allowed apps/SGs), keyed by
list index (known at plan time), not by SG id (known after apply):

```hcl
resource "aws_vpc_security_group_ingress_rule" "from_clients" {
  for_each = { for idx, sg_id in var.allowed_security_group_ids : idx => sg_id }

  security_group_id            = aws_security_group.proxy.id
  referenced_security_group_id = each.value
  from_port                    = var.db_port
  to_port                      = var.db_port
  ip_protocol                  = "tcp"
}
```

## Egress

- The `0.0.0.0/0` egress (all outbound) is acceptable for compute and proxies
  that need to pull images, logs and AWS APIs — document the why in the
  `description`.
- For SGs whose only role is to *initiate* outbound connections (e.g. the
  Lambda SG), define **egress only**; ingress to the destinations is granted by
  those destinations referencing this SG.

## Ingress from the internet — only at the public edge

`cidr_ipv4 = "0.0.0.0/0"` is allowed only on the public edge SG
(ALB/NLB) on ports 80/443, or on the bastion (SSH) — and in prod SSH should be
restricted to the corporate/VPN CIDR, not to `0.0.0.0/0`.

```hcl
# ✅ Public edge: HTTP/HTTPS from the internet to the ALB.
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}
```

## Typical access chain (edge → app → data)

```
Internet ──(80/443, CIDR 0.0.0.0/0)──▶ ALB SG
ALB SG ──(container_port, SG-ref)──────▶ App SG        (Fargate/EC2)
App SG ──(db_port, SG-ref)─────────────▶ Proxy/DB SG   (data tier)
Bastion SG ──(db_port, SG-ref)─────────▶ DB SG         (operational access)
```

Each arrow with SG-ref is an ingress rule on the destination SG, created by the
source component. The only arrow with a CIDR is the first one (internet → edge).

## Anti-patterns

```hcl
# ❌ Authorizing internal traffic by the VPC CIDR instead of by SG
cidr_ipv4 = "10.0.0.0/16"   # use referenced_security_group_id

# ❌ Database with 0.0.0.0/0 ingress
security_group_id = aws_security_group.db.id
cidr_ipv4         = "0.0.0.0/0"

# ❌ Inline rules inside aws_security_group (they hinder diffs and cross-module use)
resource "aws_security_group" "x" { ingress { ... } }

# ❌ The module that owns the SG knowing all its clients by name
#    (inverts the dependency: the client adds its rule, not the owner)
```
