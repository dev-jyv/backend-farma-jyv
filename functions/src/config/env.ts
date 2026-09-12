export const getMercadoPagoAccessToken = (): string => {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
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
    process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim() || null;

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
    const key = process.env.RESEND_API_KEY;
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
 * credenciales de R2.
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
    const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();

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
