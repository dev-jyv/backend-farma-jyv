import { getOpenRouterApiKey } from '../config/env';
import { AppError } from '../utils/errors';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Cliente mínimo de OpenRouter. La llave vive solo aquí (variable de entorno del
 * backend): el POS nunca habla con OpenRouter directo, así que la llave no
 * termina en el bundle de Angular.
 */
export const openRouterRequest = async <T>(
    path: '/chat/completions' | '/embeddings',
    body: unknown,
    timeoutMs: number,
): Promise<T> => {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
        throw new AppError(
            503,
            'OPENROUTER_NOT_CONFIGURED',
            'La extracción con IA no está configurada',
        );
    }

    let response: Response;
    try {
        response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-Title': 'FarmaJyV',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        throw new AppError(
            504,
            'OPENROUTER_UNAVAILABLE',
            error instanceof Error && error.name === 'TimeoutError'
                ? 'El servicio de IA no respondió a tiempo'
                : 'No se pudo comunicar con el servicio de IA',
        );
    }

    const payload = await response.json().catch(() => null);
    if (response.ok) {
        return payload as T;
    }
    throw toOpenRouterError(response.status, payload);
};

const extractMessage = (payload: unknown): string => {
    const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof message === 'string' && message.trim()
        ? message.trim().slice(0, 300)
        : 'Error desconocido';
};

const toOpenRouterError = (status: number, payload: unknown): AppError => {
    const message = extractMessage(payload);
    if (status === 401 || status === 403) {
        return new AppError(
            502,
            'OPENROUTER_AUTH',
            `El servicio de IA rechazó las credenciales: ${message}`,
        );
    }
    if (status === 402) {
        return new AppError(
            502,
            'OPENROUTER_CREDITS',
            'El servicio de IA no tiene créditos disponibles',
        );
    }
    if (status === 429) {
        return new AppError(
            429,
            'OPENROUTER_RATE_LIMIT',
            'El servicio de IA está saturado, intenta en un momento',
        );
    }
    return new AppError(502, 'OPENROUTER_ERROR', `El servicio de IA falló: ${message}`);
};
