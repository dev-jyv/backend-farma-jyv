import { defineSecret } from 'firebase-functions/params';
import {
    MERCADOPAGO_ACCESS_TOKEN,
    MERCADOPAGO_WEBHOOK_SECRET,
    MIGRATE_SECRET,
    OPENROUTER_API_KEY,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    RESEND_API_KEY,
} from './secrets';

type Secret = ReturnType<typeof defineSecret>;

/**
 * Valor de un secreto de `config/secrets.ts`, recortado; `null` si no tiene.
 *
 * Se lee con `.value()` en cada llamada (nunca al cargar el módulo): Firebase lo
 * monta como variable de entorno al arrancar la instancia, así que no hay
 * lectura a Secret Manager por petición. Un valor en blanco cuenta como "no
 * configurado": es lo que permite reservar el espacio de un secreto que todavía
 * no tiene valor (`MERCADOPAGO_WEBHOOK_SECRET`) y lo que el emulador recibe de
 * `.secret.local` para no salir a buscarlo a Secret Manager.
 *
 * Fuera de producción (emulador, `npm run dev`, Jest) que la variable no exista
 * es normal, y se devuelve `null` sin pasar por `.value()`, que dejaría un aviso
 * en el log en cada llamada. Desplegado sí pasa por ahí: si falta, es que la
 * función no declaró el secreto en `secrets`, y ese aviso es la pista.
 */
const readSecret = (secret: Secret): string | null => {
    if (process.env[secret.name] === undefined && !isProduction()) {
        return null;
    }
    return secret.value().trim() || null;
};

export const getMercadoPagoAccessToken = (): string => {
    const token = readSecret(MERCADOPAGO_ACCESS_TOKEN);
    if (!token) {
        throw new Error('MERCADOPAGO_ACCESS_TOKEN no está configurado');
    }
    return token;
};

export const getMercadoPagoUserId = (): string => {
    const userId = process.env.MERCADOPAGO_USER_ID;
    if (!userId) {
        throw new Error('MERCADOPAGO_USER_ID no está configurado');
    }
    return userId;
};

export const getMercadoPagoWebhookSecret = (): string | null =>
    readSecret(MERCADOPAGO_WEBHOOK_SECRET);

/** Secreto de las rutas `/v1/internal/*` (cabecera `x-migrate-secret`). */
export const getMigrateSecret = (): string | null => readSecret(MIGRATE_SECRET);

/**
 * `true` cuando corre desplegado en Cloud Functions. El emulador exporta
 * `FUNCTIONS_EMULATOR=true`, y los tests corren sin `K_SERVICE`, así que ninguno
 * de los dos se toma por producción.
 */
export const isProduction = (): boolean =>
    process.env.FUNCTIONS_EMULATOR !== 'true' &&
    (!!process.env.K_SERVICE || process.env.NODE_ENV === 'production');

/**
 * Qué imprime la terminal Point al aprobar. Por defecto `no_ticket`: el POS
 * imprime su propio ticket y el comprobante de la terminal duplica papel y
 * confunde al cliente. Valores válidos: `no_ticket`, `seller_ticket`,
 * `buyer_ticket`.
 */
export const getPointPrintOnTerminal = (): 'no_ticket' | 'seller_ticket' | 'buyer_ticket' => {
    const value = process.env.MERCADOPAGO_PRINT_ON_TERMINAL?.trim();
    return value === 'seller_ticket' || value === 'buyer_ticket' ? value : 'no_ticket';
};

/**
 * URL pública de la API (sin slash final), usada como `notification_url` de las
 * preferencias de Checkout Pro. Si no está configurada, la preferencia se crea
 * sin ella y el webhook global del panel de Mercado Pago sigue funcionando.
 */
export const getPublicApiUrl = (): string | null =>
    process.env.PUBLIC_API_URL?.trim().replace(/\/+$/, '') || null;

/**
 * URL pública del POS/tienda a la que Mercado Pago devuelve al cliente después
 * de pagar. Opcional: sin ella la preferencia se crea sin `back_urls`.
 */
export const getCheckoutReturnUrl = (): string | null =>
    process.env.MERCADOPAGO_RETURN_URL?.trim().replace(/\/+$/, '') || null;

export const getResendApiKey = (): string => {
    const key = readSecret(RESEND_API_KEY);
    if (!key) {
        throw new Error('RESEND_API_KEY no está configurado');
    }
    return key;
};

export const getReportsEmailFrom = (): string => {
    const from = process.env.REPORTS_EMAIL_FROM;
    if (!from) {
        throw new Error('REPORTS_EMAIL_FROM no está configurado');
    }
    return from;
};

export const getReportsEmailTo = (): string[] => {
    const raw = process.env.REPORTS_EMAIL_TO;
    const recipients = (raw ?? '')
        .split(',')
        .map((email) => email.trim())
        .filter(Boolean);
    if (!recipients.length) {
        throw new Error('REPORTS_EMAIL_TO no está configurado');
    }
    return recipients;
};

/** Umbral por defecto de `PRICE_DEVIATION_ALERT_MXN` (SPEC 64). */
export const DEFAULT_PRICE_DEVIATION_ALERT_MXN = 200;

/**
 * Pesos cobrados bajo el precio de catálogo en un día a partir de los cuales el
 * correo diario destaca la línea (SPEC 64). Un valor vacío, no numérico o
 * negativo cae al default: una errata no debe apagar ni disparar el aviso.
 */
export const getPriceDeviationAlertMxn = (): number => {
    const raw = process.env.PRICE_DEVIATION_ALERT_MXN?.trim();
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PRICE_DEVIATION_ALERT_MXN;
};

/**
 * Datos de la farmacia impresos en el ticket. Todos opcionales salvo el nombre,
 * que cae a un valor genérico para no romper la impresión si falta la variable.
 */
export const getReceiptStore = (): {
    name: string;
    rfc: string | null;
    address: string | null;
    phone: string | null;
    footer: string | null;
} => ({
    name: process.env.RECEIPT_STORE_NAME?.trim() || 'Farmacia JyV',
    rfc: process.env.RECEIPT_STORE_RFC?.trim() || null,
    address: process.env.RECEIPT_STORE_ADDRESS?.trim() || null,
    phone: process.env.RECEIPT_STORE_PHONE?.trim() || null,
    footer: process.env.RECEIPT_FOOTER?.trim() || null,
});

export const getAllowedOrigins = (): string[] => {
    const fallback = [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:4200',
        'https://farma-jyv.web.app',
    ].join(',');
    const raw = process.env.CORS_ORIGINS ?? fallback;

    return raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
};

/**
 * Cloudflare R2 para los comprobantes de factura.
 *
 * El `accountId` **es** el subdominio del endpoint S3
 * (`https://<accountId>.r2.cloudflarestorage.com`), así que se deriva de él en
 * vez de configurarse aparte: dos valores que tienen que coincidir y se
 * escriben a mano son dos valores que acaban sin coincidir.
 *
 * Devuelve `null` si falta cualquiera de las cuatro piezas. Con `null`, las
 * subidas siguen yendo a Firebase Storage: preferible a tumbar la caja porque
 * un secreto no está puesto, y es lo que deja el emulador funcionando sin
 * credenciales de R2. Las dos llaves son secretos de Secret Manager
 * (`config/secrets.ts`); la cuenta y el bucket no, siguen en `.env.<proyecto>`.
 */
export interface R2Config {
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Derivado, nunca configurado a mano. */
    endpoint: string;
}

export const getR2Config = (): R2Config | null => {
    const accountId = process.env.R2_ACCOUNT_ID?.trim();
    const bucket = process.env.R2_BUCKET?.trim();
    const accessKeyId = readSecret(R2_ACCESS_KEY_ID);
    const secretAccessKey = readSecret(R2_SECRET_ACCESS_KEY);

    if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
        return null;
    }

    return {
        accountId,
        bucket,
        accessKeyId,
        secretAccessKey,
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    };
};

export const isR2Enabled = (): boolean => getR2Config() !== null;

/**
 * Exige la llave de idempotencia en el alta de ventas.
 *
 * Arranca **apagada** a propósito: el POS de escritorio es otro despliegue, y
 * encenderla antes de que él la mande dejaría a la farmacia sin poder cobrar.
 * Mientras está apagada, cada venta sin llave deja un `warn` en los logs con el
 * cajero que la mandó; cuando esos avisos desaparezcan durante unos días, se
 * pone `SALES_REQUIRE_IDEMPOTENCY_KEY=true` y el hueco se cierra de verdad.
 */
export const requiresIdempotencyKey = (): boolean =>
    process.env.SALES_REQUIRE_IDEMPOTENCY_KEY?.trim() === 'true';

export const getOpenRouterApiKey = (): string | null => readSecret(OPENROUTER_API_KEY);

export const getOpenRouterVisionModel = (): string =>
    process.env.OPENROUTER_VISION_MODEL?.trim() || 'google/gemini-2.5-flash';

/** Modelo del asistente de análisis; tiene que soportar llamadas a herramientas. */
export const getOpenRouterChatModel = (): string =>
    process.env.OPENROUTER_CHAT_MODEL?.trim() || 'google/gemini-2.5-flash';

export const getOpenRouterEmbedModel = (): string =>
    process.env.OPENROUTER_EMBED_MODEL?.trim() || 'openai/text-embedding-3-small';

export type AppCheckMode = 'off' | 'log';

let warnedAppCheckMode: string | null = null;

/**
 * Modo del guard de App Check (SPEC 41). `log` verifica y registra las
 * peticiones sin token válido; `off` no verifica ni registra. **No existe un modo
 * que rechace**: eso se decide en un spec posterior con los datos que deje `log`.
 *
 * Sin la variable: `log` desplegado (prod y dev) y `off` en el emulador y en las
 * pruebas, que no tienen App Check. Un valor desconocido —`enforce` incluido— se
 * trata como `log` con un aviso: nunca debe terminar rechazando peticiones ni
 * apagando la medición por una errata.
 */
export const getAppCheckMode = (): AppCheckMode => {
    const raw = process.env.APP_CHECK_MODE?.trim().toLowerCase();
    if (!raw) {
        return isProduction() ? 'log' : 'off';
    }
    if (raw === 'off' || raw === 'log') {
        return raw;
    }
    if (warnedAppCheckMode !== raw) {
        warnedAppCheckMode = raw;
        console.warn(`APP_CHECK_MODE="${raw}" no es válido (off|log); se usa "log".`);
    }
    return 'log';
};
