# Detección de framework

Playwright mismo no depende del framework — es el mismo navegador real manejado por el mismo motor
sin importar qué renderizó la página. Esta skill solo necesita saber el framework para **dos
decisiones puntuales**, ninguna relacionada con cómo Playwright interactúa con el DOM (eso vive en
`page-object-pattern.md`):

1. **Qué advertencia aplicar sobre el comando de dev server** — el comando en sí sale de una señal
   universal (ver abajo), pero Next.js y Angular tienen cada uno un motivo concreto, ya confirmado en
   producción, para no usar ese comando tal cual.
2. **Si vale la pena ofrecer Component Testing real** (`mount()`+gallery) antes de intentarlo — un
   sí/no de alcance.

No corras este razonamiento a mano ni adivines leyendo nombres de carpetas: `scripts/detect-framework.sh`
ya lo hace determinista y lo imprime.

## La señal universal: `package.json` ya lo dice

Antes de preguntar nada sobre el framework, el script busca en `scripts` del `package.json` del
proyecto target, en este orden: `dev`, `start`, `serve` (invertido para Next.js — ver abajo). Esto
funciona igual sin importar el framework: casi cualquier proyecto Node declara alguno de los tres. Si
ninguno existe, cae al comando típico del framework detectado como último recurso.

## El matiz puntual por framework

| Framework detectado | Prioridad de script | Advertencia sobre el comando | ¿Component Testing viable? |
|---|---|---|---|
| Angular (`angular.json`) | `dev, start, serve` | Si el comando no trae ya `--no-live-reload`, agrégalo: el HMR puede recargar la página a mitad de un test — exactamente el bug que esto previene se encontró y confirmó en producción escribiendo esta skill. | No — sin gallery oficial ni comunitaria vigente. Todo "componente individual" se prueba vía su página real. |
| Next.js (`next.config.*`) | `start, dev, serve` (invertida: `start` casi siempre es el servidor de producción) | Preferir `next build && next start` sobre `next dev` para E2E — el fast refresh puede recargar a mitad de un test. Si el script `start` ya corre `next start`, úsalo tal cual. | Solo client components, vía una gallery Vite aparte — fuera de alcance de esta skill. Los Server Components async nunca se pueden montar aislados: si el flujo depende de uno, es E2E sí o sí. |
| Vue / Nuxt | `dev, start, serve` | Ninguna conocida | Sí, vía gallery Vite — fuera de alcance aquí; remitir al skill oficial `playwright-component-testing` de Microsoft si se pide explícitamente. |
| React (sin Next.js) | `dev, start, serve` | Ninguna conocida | Sí, vía gallery Vite — mismo tratamiento que Vue. |
| Ninguna señal reconocida | `dev, start, serve` | Pregúntale al usuario el comando y el puerto; confirma que el servidor sirve una SPA/SSR navegable, no una API pura. | Sin confirmar — terreno nuevo. |

## Instalación de Playwright si no está presente

1. `@playwright/test` como devDependency con el gestor de paquetes del proyecto (detectado por la
   presencia de `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, o `bun.lock`).
2. Antes de asumir que el navegador ya se descargó, revisa si el gestor bloquea scripts de
   instalación de dependencias:
   - pnpm 10+: puede requerir `onlyBuiltDependencies` o dejar el postinstall sin correr — confirma
     revisando si `playwright` tiene binarios instalados en el store (`.cache/ms-playwright` o
     equivalente), no asumas que `pnpm install` bastó.
   - npm/yarn con `--ignore-scripts` configurado globalmente: mismo problema.
3. Si el navegador no está instalado, corre `npx playwright install chromium` explícito — no dependas
   de un postinstall que puede no haber corrido.
