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

export interface EmailAttachment {
    filename: string;
    content: Buffer;
}

export const sendReportEmail = async (input: {
    subject: string;
    react: ReactElement;
    /** Opcional: las alertas de inventario van sin PDF adjunto. */
    attachment?: EmailAttachment;
    /** Varios adjuntos (correo del contador, SPEC 45); se suman a `attachment`. */
    attachments?: EmailAttachment[];
    /**
     * Destinatarios. Sin él va a `REPORTS_EMAIL_TO`, como siempre. Una lista
     * vacía es un error del llamador, no "manda a la lista por defecto".
     */
    to?: string[];
}): Promise<void> => {
    if (input.to && input.to.length === 0) {
        throw new Error('sendReportEmail: la lista de destinatarios está vacía');
    }
    const attachments = [
        ...(input.attachment ? [input.attachment] : []),
        ...(input.attachments ?? []),
    ].map(({ filename, content }) => ({ filename, content }));
    const html = await render(input.react);
    const { error } = await resend().emails.send({
        from: getReportsEmailFrom(),
        to: input.to ?? getReportsEmailTo(),
        subject: input.subject,
        html,
        ...(attachments.length > 0 ? { attachments } : {}),
    });
    if (error) {
        throw new Error(`Error al enviar el correo con Resend: ${error.message}`);
    }
};
