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
