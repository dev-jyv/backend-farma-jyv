import { Response } from 'express';

/**
 * Entrega un archivo con `@Res()`: el interceptor de la app envuelve toda
 * respuesta en `{ data }` y un archivo envuelto en JSON no lo abre nadie.
 */
export const sendFile = (
    res: Response,
    file: { body: Buffer; contentType: string; fileName: string },
): void => {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    // Sin esto el navegador no puede leer el nombre del archivo desde otro origen.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(file.body);
};
