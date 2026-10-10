/**
 * Archivo ya parseado por `FileUploadInterceptor`.
 *
 * Es un tipo propio y no `Express.Multer.File`: multer no se usa en runtime
 * —el parseo lo hace Busboy directamente, porque multer no contempla el
 * `req.rawBody` que Cloud Functions v2 entrega en los multipart— y mantenerlo
 * como dependencia solo por su declaración de tipos dejaba un paquete
 * instalado que nada importa.
 */
export interface UploadedFile {
    /** Nombre del campo del formulario (siempre `file`). */
    fieldname: string;
    /** Nombre con el que el cliente mandó el archivo. */
    originalname: string;
    encoding: string;
    /** Tipo detectado por los primeros bytes, no el declarado por el cliente. */
    mimetype: string;
    size: number;
    buffer: Buffer;
}
