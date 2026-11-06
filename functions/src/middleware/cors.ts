import cors from 'cors';
import { getAllowedOrigins } from '../config/env';

export const corsMiddleware = cors({
    origin: (origin, callback) => {
        const allowed = getAllowedOrigins();
        if (!origin || allowed.includes(origin) || allowed.includes('*')) {
            callback(null, true);
            return;
        }
        callback(new Error('Origen no permitido por CORS'));
    },
    credentials: true,
    // La caja y el panel miden el desfase de su reloj contra el header `Date` de
    // la respuesta (SPEC 65); sin exponerlo, el navegador no lo deja leer.
    exposedHeaders: ['Date'],
});
