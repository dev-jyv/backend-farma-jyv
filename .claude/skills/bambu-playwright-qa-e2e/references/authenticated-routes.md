# Rutas protegidas por sesión/token

Casi cualquier flujo crítico real vive detrás de un login. El objetivo de esta skill es escribir
specs que prueben la app tal como se comporta en producción, no specs que solo pasan porque el guard
de autenticación está apagado o es un stub que siempre deja pasar.

## Antes de escribir nada: ¿esta ruta requiere sesión?

Confírmalo, no lo asumas:

- Intenta navegar directo a la ruta objetivo sin loguearte. Si redirige a login o responde 401/403,
  está protegida.
- Si está protegida, confirma cómo se obtiene una sesión de prueba **en este proyecto concreto**:
  ¿hay un usuario de prueba documentado? ¿Un modo de test que desactiva 2FA/CAPTCHA? ¿Un OTP fijo en
  el ambiente de desarrollo? **No inventes credenciales ni asumas `admin/admin`.** Si no hay una forma
  confirmada de conseguir una sesión válida, dile esto al usuario explícitamente en vez de intentar un
  workaround frágil.

## El patrón estándar: `storageState` + proyecto de setup

1. Un proyecto de Playwright dedicado a `setup` que corre primero:
   - Hace login — por UI si no hay atajo, o directo contra el endpoint de login con `request.post()`
     si existe y es más rápido.
   - Guarda el estado del navegador tras el login:
     `await page.context().storageState({ path: 'playwright/.auth/user.json' })`.
2. Los demás proyectos en `playwright.config.ts` declaran
   `use: { storageState: 'playwright/.auth/user.json' }` y `dependencies: ['setup']`, heredando la
   sesión ya lista. Cada spec arranca logueado, sin repetir el flujo de login en cada test — más
   rápido y no acopla cada spec a que el login por UI siga funcionando.
3. **El login por UI sigue teniendo su propio spec aparte** (feliz + edge cases de credenciales
   inválidas, igual que cualquier otro formulario del catálogo). No se salta — es uno de los flujos
   más críticos de cualquier app. `storageState` es para todos los demás specs que no están probando
   el login en sí.

## Varios roles = varios `storageState`

Si hay más de un rol (colaborador/admin, usuario/superadmin), normalmente hace falta un
`storageState` por rol: un proyecto de setup por cada uno, o un setup único que loguea distintos
usuarios y guarda archivos separados. Cada spec usa el `project` que corresponde al rol que necesita.

## Login basado en token (SPA con JWT en `localStorage` o header `Authorization`)

`storageState` de Playwright captura cookies **y** `localStorage` por origen, así que un token
guardado en `localStorage` (patrón común de SPA) queda incluido igual. Dos riesgos a confirmar en
vivo, no asumir:

- Si el token expira rápido (minutos), un `storageState` capturado una sola vez puede quedar
  inválido a mitad de una corrida larga — confirmar el tiempo de vida antes de decidir si hace falta
  refrescarlo periódicamente o loguear una vez por archivo de test en vez de una vez para toda la
  suite.
- Si hay un refresh token en una cookie `httpOnly` separada con su propia lógica, confirmar que
  `storageState` por sí solo la reproduce — a veces no es suficiente y hace falta un paso adicional en
  el setup.

## Cuando no hay atajo limpio

### OTP (código de un solo uso, por correo o SMS)

En orden de preferencia, confirmar cuál existe antes de intentar cualquiera:

1. **Modo de prueba con código fijo o bypass** — muchos proyectos ya lo tienen precisamente por esto
   (ver `login.ts` en este mismo repo: `000000` inválido, `111111` expirado, cualquier otro pasa).
   Preguntar antes de asumir que no existe.
2. **Leer el código real vía API** — un buzón de correo de prueba consultable programáticamente
   (Mailosaur, Mailtrap, Ethereal, o la API del proveedor de correo del proyecto) para OTP por email;
   un número de prueba vía Twilio (su API expone los SMS recibidos) para OTP por SMS. Más
   infraestructura, pero automatizable de verdad — no es un placeholder.
3. **Si ninguna existe**: `storageState` capturado manualmente una vez (una persona hace el login real
   una sola vez) y decir explícitamente en el reporte final que el paso del OTP en sí queda fuera de
   la suite automatizada — no simular que se cubrió.

### SSO/OAuth de un proveedor externo (Google, Facebook, Okta, Azure AD...)

Esto no es solo más difícil técnicamente — los proveedores **bloquean activamente** navegadores
automatizados en su propia pantalla de login (CAPTCHA, "este navegador no es seguro") como medida de
seguridad deliberada, no como un bug a esquivar. Intentar automatizar su UI real es frágil incluso
cuando "funciona", y en muchos casos viola sus términos de servicio.

En orden de preferencia:

1. **Endpoint de bypass en el propio backend del proyecto** — algo como `POST /test/login-as`
   habilitado solo en ambientes de test, que entrega una sesión válida para un usuario de prueba sin
   pasar por el proveedor externo. El equivalente exacto del código fijo de OTP, pero para OAuth.
2. **API de testing del proveedor de identidad**, si el proyecto ya usa uno (Auth0, Okta y similares
   suelen ofrecer una forma de crear sesiones de prueba sin tocar su UI) — confirmar si ya hay acceso
   a eso antes de asumir que no existe.
3. **`storageState` capturado manualmente una vez** — una persona hace el login real por OAuth una
   sola vez; la suite reutiliza esa sesión hasta que expire, momento en el que hay que repetirlo a
   mano. No prueba el login en sí, pero sí todo lo que vive detrás.
4. **Nunca**: meter credenciales reales de una cuenta de Google/Facebook/etc. en el script e intentar
   automatizar su formulario de login real.

### CAPTCHA

Casi nunca automatizable. Confirmar si está desactivado en el ambiente de pruebas — muchos proyectos
lo desactivan ahí precisamente por esto.

### En cualquiera de los tres casos

Si no se puede confirmar una forma real de conseguir una sesión (ni código fijo, ni API de testing, ni
bypass de backend), decirlo explícitamente en el reporte final en vez de simular que el flujo quedó
cubierto. Un spec que "pasa" solo porque evita el problema sin decirlo es peor que no tener spec.
