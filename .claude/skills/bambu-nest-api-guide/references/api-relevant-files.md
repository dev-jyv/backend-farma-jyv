# Qué cuenta como contrato de API

## Incluir

```bash
git diff --name-status <rango> -- \
  'src/**/*.controller.ts' \
  'src/**/*.dto.ts' \
  'libs/**/*.dto.ts'
```

- **Controladores** (`*.controller.ts`) — rutas, métodos HTTP, guards/decorators de auth (`@AuthAdminOnly()`, `@AuthCustomerOnly()`, etc.), `@ApiTags`.
- **DTOs de request/response** (`*.dto.ts`, `*-response.dto.ts`) — shape del body/query/params, decoradores de `class-validator` (`@IsString`, `@IsOptional`, `@IsEnum`, `@IsNumber`, `@MaxLength`, …) y de `@nestjs/swagger` (`@ApiProperty`, `@ApiPropertyOptional`).
- **Enums exportados** que un DTO referencia, si cambiaron sus valores.
- `src/i18n/*/validation.json` — **solo** si aporta contexto a un mensaje de validación relevante (ej. aclara qué regla se está aplicando a un campo). No lo trates como cambio de API en sí mismo.

## Ignorar

- Archivos de test (`*.spec.ts`) y fixtures.
- Cambios puramente internos (mappers, servicios, repositorios) que **no** alteren el contrato HTTP expuesto.

## Excepción: cambio interno que sí es cambio de contrato

Un cambio en un mapper/servicio interno **sí cuenta** si altera lo que el cliente recibe aunque el DTO no haya cambiado de shape declarado — por ejemplo, un mapper que ahora omite un campo del response, o que transforma un valor de forma distinta (fecha ISO → timestamp, string → slug). Verifica el cuerpo real devuelto, no solo la firma del DTO, cuando el diff toca la capa de mapeo de un endpoint que de otra forma parecería sin cambios.
