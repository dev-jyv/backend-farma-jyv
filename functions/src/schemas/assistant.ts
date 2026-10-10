import { z } from 'zod';

export const ASSISTANT_MAX_MESSAGES = 20;
export const ASSISTANT_MAX_MESSAGE_CHARS = 4000;

export const assistantChatSchema = z.object({
    messages: z
        .array(
            z.object({
                role: z.enum(['user', 'assistant']),
                content: z
                    .string()
                    .trim()
                    .min(1, 'El mensaje no puede estar vacío')
                    .max(
                        ASSISTANT_MAX_MESSAGE_CHARS,
                        `Máximo ${ASSISTANT_MAX_MESSAGE_CHARS} caracteres por mensaje`,
                    ),
            }),
        )
        .min(1, 'Se requiere al menos un mensaje')
        .max(ASSISTANT_MAX_MESSAGES, `Máximo ${ASSISTANT_MAX_MESSAGES} mensajes`)
        .refine((messages) => messages[messages.length - 1]?.role === 'user', {
            message: 'El último mensaje debe ser del usuario',
        }),
});

export type AssistantChatInput = z.infer<typeof assistantChatSchema>;

/** Acciones que la ayuda con IA puede proponer; espejo de los botones del panel del POS. */
export const SYNC_HELP_ACTIONS = ['reintentar', 'corregir', 'avisar-admin'] as const;

/**
 * Registro bloqueado al sincronizar, resumido por el POS. Sin cliente, partidas
 * ni payload: solo lo necesario para explicar el motivo.
 */
export const syncHelpSchema = z.object({
    kind: z.enum(['sale', 'cashMovement', 'cashSession']),
    code: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(1).max(500),
    dependency: z
        .object({
            kind: z.enum(['cashSession', 'product']),
            label: z.string().trim().max(120),
        })
        .optional(),
    appVersion: z.string().trim().max(40).optional(),
});

export type SyncHelpInput = z.infer<typeof syncHelpSchema>;
