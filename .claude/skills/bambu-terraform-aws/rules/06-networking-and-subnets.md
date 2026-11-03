# 06 — Networking and subnet tiers

Every VPC is built with **three tiers** of subnets, each replicated across at
least **2 AZs**. The tier determines what each component exposes to the internet.
This structure is the common foundation of every project, independent of the
application layer.

## The three tiers

| Tier (`Tier`) | Route to internet | What lives here | `map_public_ip_on_launch` |
|---------------|-----------------|---------------|---------------------------|
| `public` | Direct via **IGW** | ALB, NAT Gateway, bastion. Nothing with data. | `true` |
| `private` | **Egress only** via NAT GW | Application compute: Fargate, app EC2, Lambdas in VPC, EKS nodes. | `false` |
| `data` | **Egress only** via NAT GW | RDS, RDS Proxy, ElastiCache, Aurora. **Never accessible from the internet.** | `false` |

Golden rule: **data is never public**. Any stateful store (database, cache) goes
in the `data` tier, with `publicly_accessible = false` and reachable only by SG
from the application layer (see rule 07).

## Routing per tier

- **public** → route table with a `0.0.0.0/0` route to the **Internet Gateway**.
- **private** and **data** → route table with a `0.0.0.0/0` route to the **NAT Gateway**
  (outbound egress for patching, ECR pulls, calls to AWS APIs), **with no
  inbound route from the internet**.

```hcl
# Egress for private/data via NAT; never an inbound route from the IGW.
resource "aws_route" "private_nat" {
  count                  = local.nat_enabled ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this["0"].id
}
```

## NAT Gateway — cost vs. resilience

- `single_nat_gateway = true` → **1 shared NAT GW** (default for `dev`,
  cost-optimized). All private tiers egress through it.
- `single_nat_gateway = false` → **1 NAT GW per AZ** (recommended in `prod`
  so egress isn't lost if an AZ goes down).

> If an environment switches to `single_nat_gateway = false`, the VPC module must
> create route tables **per AZ** so that each private subnet egresses through the
> NAT of its own zone. With a single route table per tier, everything points to
> the first NAT.

## Subnets with `for_each` indexed by AZ

Subnets are created with a map indexed by AZ index (never `count`), so that
adding/removing an AZ doesn't recreate the others (see rule 05):

```hcl
locals {
  public_subnets  = { for idx, cidr in var.public_subnet_cidrs : idx => { cidr = cidr, az = var.azs[idx] } }
  private_subnets = { for idx, cidr in var.private_subnet_cidrs : idx => { cidr = cidr, az = var.azs[idx] } }
  data_subnets    = { for idx, cidr in var.data_subnet_cidrs : idx => { cidr = cidr, az = var.azs[idx] } }
}
```

## CIDR planning

- Each **environment** uses a CIDR block that **does not overlap** with the others
  (e.g. dev `10.0.0.0/22`, prod `10.1.0.0/20`), to allow future peering.
- Within the VPC, split the space across the 3 tiers × N AZs and **reserve** an
  unassigned range for growth (more AZs, EKS, peering).
- The VPC enables `enable_dns_support` and `enable_dns_hostnames`.

## DB Subnet Group / data subnet groups

Data stores reference **only the `data` tier subnets**. AWS requires subnets in
≥ 2 AZs even for single-AZ instances:

```hcl
resource "aws_db_subnet_group" "this" {
  name       = "${local.name_prefix}-rds-subnet-group"
  subnet_ids = var.data_subnet_ids   # never public subnets
}
```

## Anti-patterns

```hcl
# ❌ Database in a public or accessible subnet
publicly_accessible = true

# ❌ Inbound route from the internet to private/data
resource "aws_route" "data_from_igw" { gateway_id = aws_internet_gateway.this.id }

# ❌ App compute in a public subnet "so it's easy to reach"
#    (public access enters through the ALB/CloudFront in the public tier, not through the compute)

# ❌ Mixing components with data into the private/public tier
```
