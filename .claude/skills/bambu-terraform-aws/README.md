# bambu-terraform-aws

Skill de Claude Code con convenciones **reutilizables y agnósticas del proyecto**
para generar, modificar o revisar infraestructura Terraform en AWS: estructura de
módulos/environments, naming, tagging, VPC de 3 capas, security groups, baseline
de seguridad Well-Architected, y una capa de aplicación intercambiable (Lambda,
Fargate, EC2, EKS) sobre una base común.

## Estructura (auto-contenida)

```
bambu-terraform-aws/
├── SKILL.md                              # metadata + flujo de trabajo al crear un módulo
└── rules/
    ├── 01-module-structure.md
    ├── 02-environment-structure.md
    ├── 03-naming.md
    ├── 04-tagging.md
    ├── 05-iteration-and-outputs.md
    ├── 06-networking-and-subnets.md
    ├── 07-security-groups.md
    ├── 08-security-and-well-architected.md
    ├── 09-application-layer.md
    └── 10-environment-documentation.md
```

## Instalación

Copia esta carpeta a donde Claude Code detecta skills:

```bash
# A nivel usuario (sirve para todos tus proyectos de AWS/Terraform)
cp -R bambu-terraform-aws ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-terraform-aws <tu-proyecto>/.claude/skills/
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-terraform-aws`.

## Uso

Se carga automáticamente al trabajar en `modules/` o `environments/`, por
ejemplo:

- *"Crea un módulo de Terraform para RDS."*
- *"Agrega un ambiente de staging con el mismo baseline que producción."*
- *"Configura la VPC con las tres capas."*
- *"Cambia la capa de aplicación de este proyecto de Lambda a Fargate."*
- *"Revisa este módulo de Terraform contra nuestras convenciones de seguridad."*

También acepta invocación directa con el nombre del componente como argumento:

```text
/bambu-terraform-aws rds
/bambu-terraform-aws lambda-api
/bambu-terraform-aws eks
```

Si el pedido no trae requisitos claros (puertos, público/privado, si persiste
datos, dependencias), la skill pregunta antes de generar código. Luego inspecciona
el estado real del repo (`environments/`, `modules/`) — las reglas son la forma
de trabajar, el repo es la verdad concreta — genera los archivos del módulo,
lo cablea en el `main.tf` del environment, actualiza `variables.tf` /
`outputs.tf` / `terraform.tfvars`, y corre `terraform fmt -recursive` +
`terraform validate`.

## Principio guía

La base (VPC de 3 capas, RDS privado, tags, state, seguridad) **no cambia**
aunque el proyecto pase de serverless a contenedores — solo cambia el módulo de
cómputo y su cableado en `main.tf`.

Licencia: MIT · Bambu Tech Services.
