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
