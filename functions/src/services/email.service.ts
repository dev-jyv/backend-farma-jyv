import { ReactElement } from 'react';
import { render } from '@react-email/render';
import { Resend } from 'resend';
import { getReportsEmailFrom, getReportsEmailTo, getResendApiKey } from '../config/env';

let client: Resend | undefined;

const resend = (): Resend => {
    if (!client) {
        client = new Resend(getResendApiKey());
    }
    return client;
};

export const sendReportEmail = async (input: {
    subject: string;
    react: ReactElement;
    /** Opcional: las alertas de inventario van sin PDF adjunto. */
    attachment?: { filename: string; content: Buffer };
}): Promise<void> => {
    const html = await render(input.react);
    const { error } = await resend().emails.send({
        from: getReportsEmailFrom(),
        to: getReportsEmailTo(),
        subject: input.subject,
        html,
        ...(input.attachment
            ? {
                attachments: [{
                    filename: input.attachment.filename,
                    content: input.attachment.content,
                }],
            }
            : {}),
    });
    if (error) {
        throw new Error(`Error al enviar el correo con Resend: ${error.message}`);
    }
};
