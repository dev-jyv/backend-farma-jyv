import 'reflect-metadata';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { SYSTEM_ROLE_DEFINITIONS, hasPermission } from '../src/constants/permissions';
import { ALLOWED_UPLOAD_MIME_TYPES } from '../src/constants/uploads';
import { FileUploadInterceptor } from '../src/modules/uploads/file-upload.interceptor';
import { PERMISSION_KEY } from '../src/modules/identity/decorators/require-permission.decorator';
import { PermissionsGuard } from '../src/modules/identity/guards/permissions.guard';
import { UploadsController } from '../src/modules/uploads/uploads.controller';
import { AppError } from '../src/utils/errors';
import { sanitizeFileName } from '../src/utils/storage';
import { AuthUser, PermissionArea, RolePermission } from '../src/types';

/**
 * Subida de comprobantes (factura de proveedor).
 *
 * Es una entrada de archivos desde el mostrador, así que lo que se prueba es lo
 * que un archivo mal intencionado o mal formado puede lograr: pasar por un tipo
 * que no es, agotar memoria, o escribir fuera del prefijo que le toca en
 * Storage. Todo es puro: no toca el emulador ni sube nada a Storage real.
 */

const MB = 1024 * 1024;

/* ── Contenidos reales por tipo (los primeros bytes son lo que se valida) ── */

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('contenido')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF')]);
const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('IHDR'),
]);
const WEBP = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x20, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    Buffer.from('VP8 '),
]);
/** Un ejecutable de Windows. El caso que el `Content-Type` del cliente tapaba. */
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x90)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

const BOUNDARY = '----limiteDePrueba1234';

type Parte =
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; content: Buffer };

/** Arma el cuerpo multipart tal como llega desde el POS. */
const multipart = (partes: Parte[]): Buffer => {
    const chunks: Buffer[] = [];
    for (const parte of partes) {
        chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
        if ('value' in parte) {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${parte.name}"\r\n\r\n`,
            ));
            chunks.push(Buffer.from(parte.value));
        } else {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${parte.name}"; ` +
                `filename="${parte.filename}"\r\n` +
                `Content-Type: ${parte.contentType}\r\n\r\n`,
            ));
            chunks.push(parte.content);
        }
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(chunks);
};

const interceptor = new FileUploadInterceptor();

const contextoDe = (req: Partial<Request>): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => req }),
} as unknown as ExecutionContext);

const handler: CallHandler = { handle: () => of('siguiente') };

/**
 * Corre el interceptor sobre un cuerpo multipart y devuelve el `req.file` que
 * dejó. Usa `rawBody`, que es la forma en la que Cloud Functions v2 entrega el
 * multipart.
 */
const subir = async (partes: Parte[], contentType?: string): Promise<Request> => {
    const req = {
        headers: {
            'content-type': contentType ??
                `multipart/form-data; boundary=${BOUNDARY}`,
        },
        rawBody: multipart(partes),
    } as unknown as Request;

    await firstValueFrom(interceptor.intercept(contextoDe(req), handler));
    return req;
};

const archivo = (overrides: Partial<Extract<Parte, { filename: string }>> = {}): Parte => ({
    name: overrides.name ?? 'file',
    filename: overrides.filename ?? 'factura.pdf',
    contentType: overrides.contentType ?? 'application/pdf',
    content: overrides.content ?? PDF,
});

describe('FileUploadInterceptor: tipos aceptados', () => {
    it('acepta un PDF', async () => {
        const req = await subir([archivo()]);

        expect(req.file).toMatchObject({
            fieldname: 'file',
            originalname: 'factura.pdf',
            mimetype: 'application/pdf',
            size: PDF.length,
        });
        expect(req.file?.buffer.equals(PDF)).toBe(true);
    });

    it('acepta JPEG, PNG y WebP', async () => {
        const casos: [string, string, Buffer, string][] = [
            ['comprobante.jpg', 'image/jpeg', JPEG, 'image/jpeg'],
            ['comprobante.png', 'image/png', PNG, 'image/png'],
            ['comprobante.webp', 'image/webp', WEBP, 'image/webp'],
        ];

        for (const [filename, contentType, content, esperado] of casos) {
            const req = await subir([archivo({ filename, contentType, content })]);
            expect(req.file?.mimetype).toBe(esperado);
        }
    });

    it('los tipos permitidos son exactamente PDF y las tres imágenes', () => {
        expect([...ALLOWED_UPLOAD_MIME_TYPES].sort()).toEqual([
            'application/pdf',
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/webp',
        ]);
    });
});

describe('FileUploadInterceptor: tipos rechazados', () => {
    const esperarBadRequest = async (partes: Parte[], patron?: RegExp) => {
        const error = await subir(partes).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(400);
        if (patron) {
            expect((error as AppError).message).toMatch(patron);
        }
    };

    it('rechaza un tipo declarado que no está permitido', async () => {
        await esperarBadRequest(
            [archivo({ filename: 'notas.txt', contentType: 'text/plain', content: PDF })],
            /no permitido/i,
        );
    });

    it('rechaza un .exe disfrazado de PDF: se valida el contenido, no el header', async () => {
        // Es el caso que la validación por `Content-Type` del cliente dejaba pasar.
        await esperarBadRequest(
            [archivo({ filename: 'factura.pdf', contentType: 'application/pdf', content: EXE })],
            /no permitido/i,
        );
    });

    it('rechaza un HTML disfrazado de imagen', async () => {
        await esperarBadRequest(
            [archivo({ filename: 'foto.png', contentType: 'image/png', content: HTML })],
        );
    });

    it('rechaza un archivo vacío: sin bytes no hay tipo que confirmar', async () => {
        await esperarBadRequest(
            [archivo({ content: Buffer.alloc(0) })],
        );
    });

    it('rechaza un archivo truncado que no alcanza para la firma', async () => {
        // `%PD` no es `%PDF-`: un PDF cortado no es un PDF.
        await esperarBadRequest([archivo({ content: Buffer.from('%PD') })]);
    });

    it('rechaza un RIFF que no es WebP', async () => {
        const riffAvi = Buffer.concat([
            Buffer.from('RIFF'),
            Buffer.from([0x20, 0x00, 0x00, 0x00]),
            Buffer.from('AVI '),
        ]);
        await esperarBadRequest(
            [archivo({ filename: 'video.webp', contentType: 'image/webp', content: riffAvi })],
        );
    });

    it('corrige el tipo al real cuando el declarado también estaba permitido', async () => {
        // Declara PDF pero manda un PNG: el tipo real está permitido, así que se
        // acepta y se guarda con el tipo verdadero, no con el que dijo el cliente.
        const req = await subir([
            archivo({ filename: 'factura.pdf', contentType: 'application/pdf', content: PNG }),
        ]);

        expect(req.file?.mimetype).toBe('image/png');
    });
});

describe('FileUploadInterceptor: límite de tamaño', () => {
    it('acepta un archivo por debajo del límite', async () => {
        const grande = Buffer.concat([PDF, Buffer.alloc(2 * MB, 0x20)]);
        const req = await subir([archivo({ content: grande })]);

        expect(req.file?.size).toBe(grande.length);
    });

    it('rechaza un archivo de más de 10MB', async () => {
        const excedido = Buffer.concat([PDF, Buffer.alloc(10 * MB, 0x20)]);

        const error = await subir([archivo({ content: excedido })])
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(400);
        expect((error as AppError).message).toMatch(/10MB/);
    });

    it('rechaza un multipart con demasiados campos de texto', async () => {
        const campos: Parte[] = Array.from({ length: 12 }, (_, index) => ({
            name: `campo${index}`,
            value: 'x',
        }));

        const error = await subir([...campos, archivo()]).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).message).toMatch(/campos|partes/i);
    });
});

describe('FileUploadInterceptor: nombre de archivo', () => {
    /** Lo que de verdad importa: qué ruta de Storage produce ese nombre. */
    const rutaDe = (fileName: string) => `uploads/ID/${sanitizeFileName(fileName)}`;

    it('un nombre con ../ no puede salir del prefijo uploads/', () => {
        expect(rutaDe('../../etc/passwd')).toBe('uploads/ID/.._.._etc_passwd');
        expect(rutaDe('../../../clinical/paciente/estudio.pdf'))
            .toBe('uploads/ID/.._.._.._clinical_paciente_estudio.pdf');
        expect(rutaDe('..\\..\\windows\\system32')).toBe('uploads/ID/.._.._windows_system32');
    });

    it('un nombre de puros puntos no nombra un directorio', () => {
        // `uploads/ID/..` resolvía al prefijo padre y `uploads/ID/.` dejaba la
        // ruta terminada en separador.
        expect(sanitizeFileName('..')).toBe('archivo');
        expect(sanitizeFileName('.')).toBe('archivo');
        expect(sanitizeFileName('...')).toBe('archivo');
        expect(rutaDe('..')).toBe('uploads/ID/archivo');
    });

    it('un nombre vacío o de puros caracteres inválidos deja un nombre usable', () => {
        expect(sanitizeFileName('')).toBe('archivo');
        expect(sanitizeFileName('///')).toBe('___');
        expect(sanitizeFileName('   ')).toBe('___');
    });

    it('quita separadores, bytes de control y comodines', () => {
        expect(sanitizeFileName('a/b')).toBe('a_b');
        expect(sanitizeFileName('a\\b')).toBe('a_b');
        expect(sanitizeFileName('factura .pdf')).toBe('factura_.pdf');
        expect(sanitizeFileName('factura\n\r.pdf')).toBe('factura__.pdf');
        expect(sanitizeFileName('fact*ura?.pdf')).toBe('fact_ura_.pdf');
        expect(sanitizeFileName('%2e%2e%2ffactura.pdf')).toBe('_2e_2e_2ffactura.pdf');
    });

    it('no deja pasar comillas ni etiquetas: el nombre se muestra en el panel', () => {
        expect(sanitizeFileName('<script>alert(1)</script>.pdf'))
            .toBe('_script_alert_1___script_.pdf');
        expect(sanitizeFileName('factura";DROP TABLE.pdf')).toBe('factura__DROP_TABLE.pdf');
    });

    it('conserva letras, dígitos, punto, guion y guion bajo', () => {
        expect(sanitizeFileName('Factura_2026-09-01.v2.pdf')).toBe('Factura_2026-09-01.v2.pdf');
    });

    it('reemplaza los acentos en vez de romper la ruta', () => {
        expect(sanitizeFileName('facturación.pdf')).toBe('facturaci_n.pdf');
        expect(sanitizeFileName('ñoño.pdf')).toBe('_o_o.pdf');
    });

    it('acota la longitud y conserva la extensión', () => {
        // Google Cloud Storage acota el nombre del objeto a 1024 bytes: un
        // `originalname` kilométrico hacía fallar la subida con el archivo ya
        // en memoria.
        const largo = `${'a'.repeat(5000)}.pdf`;
        const resultado = sanitizeFileName(largo);

        expect(resultado.length).toBeLessThanOrEqual(120);
        expect(resultado.endsWith('.pdf')).toBe(true);
    });

    it('un nombre largo sin extensión también se acota', () => {
        expect(sanitizeFileName('b'.repeat(5000)).length).toBeLessThanOrEqual(120);
    });

    it('el interceptor conserva el nombre original: sanear es tarea de la ruta', async () => {
        const req = await subir([archivo({ filename: '../factura rara.pdf' })]);

        expect(req.file?.originalname).toContain('factura rara.pdf');
        expect(sanitizeFileName(req.file!.originalname)).not.toContain('/');
    });
});

describe('FileUploadInterceptor: peticiones mal formadas', () => {
    it('exige multipart/form-data', () => {
        const req = { headers: { 'content-type': 'application/json' } } as unknown as Request;

        expect(() => interceptor.intercept(contextoDe(req), handler))
            .toThrow(/multipart\/form-data/);
    });

    it('rechaza una petición sin Content-Type', () => {
        const req = { headers: {} } as unknown as Request;

        expect(() => interceptor.intercept(contextoDe(req), handler)).toThrow(AppError);
    });

    it('rechaza un multipart sin archivo', async () => {
        const error = await subir([{ name: 'invoiceId', value: 'INV-1' }])
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).message).toMatch(/archivo es requerido/i);
    });

    it('rechaza un archivo enviado en otro campo que no sea `file`', async () => {
        const error = await subir([archivo({ name: 'adjunto' })])
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).message).toMatch(/archivo es requerido/i);
    });

    it('rechaza un multipart con más de un archivo', async () => {
        // El límite de busboy es 1: el segundo adjunto corta la petición en vez
        // de subirse en silencio o de tapar al primero.
        const error = await subir([
            archivo({ name: 'otro', filename: 'ignorado.png', content: PNG }),
            archivo({ filename: 'factura.pdf', content: PDF }),
        ]).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(400);
        expect((error as AppError).message).toMatch(/un archivo/i);
    });

    it('acepta campos de texto junto al archivo', async () => {
        const req = await subir([
            { name: 'invoiceId', value: 'INV-1' },
            archivo(),
        ]);

        expect(req.file?.originalname).toBe('factura.pdf');
    });

    it('llama al handler siguiente solo cuando el archivo es válido', async () => {
        const siguiente = jest.fn(() => of('ok'));
        const req = {
            headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
            rawBody: multipart([archivo({ content: EXE })]),
        } as unknown as Request;

        await firstValueFrom(
            interceptor.intercept(contextoDe(req), { handle: siguiente }),
        ).catch(() => undefined);

        expect(siguiente).not.toHaveBeenCalled();
    });
});

describe('permisos de la subida', () => {
    const AREA: PermissionArea = 'uploads';
    const proto = UploadsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
    >;

    const permisosDe = (slug: keyof typeof SYSTEM_ROLE_DEFINITIONS): RolePermission[] =>
        SYSTEM_ROLE_DEFINITIONS[slug].permissions;

    const usuario = (slug: string, permissions: RolePermission[]): AuthUser => ({
        uid: 'u1',
        email: 'x@y.z',
        role: { id: 'r1', slug, name: slug },
        permissions,
    } as unknown as AuthUser);

    const guardContexto = (authUser?: AuthUser): ExecutionContext => ({
        getHandler: () => proto.upload,
        getClass: () => UploadsController,
        switchToHttp: () => ({ getRequest: () => ({ authUser }) }),
    } as unknown as ExecutionContext);

    it('el endpoint exige el área uploads en escritura', () => {
        const metadato = new Reflector().getAllAndOverride<{ area: string; level: string }>(
            PERMISSION_KEY,
            [proto.upload, UploadsController],
        );
        expect(metadato).toEqual({ area: AREA, level: 'write' });
    });

    it('el cajero puede subir el comprobante al dar de alta una factura', () => {
        expect(permisosDe('cashier')).toContainEqual({ area: AREA, level: 'write' });
        expect(new PermissionsGuard(new Reflector())
            .canActivate(guardContexto(usuario('cashier', permisosDe('cashier'))))).toBe(true);
    });

    it('un rol sin el área recibe 403', () => {
        const guard = new PermissionsGuard(new Reflector());
        const doctor = usuario('doctor', permisosDe('doctor'));

        expect(hasPermission(permisosDe('doctor'), AREA, 'write', 'doctor')).toBe(false);
        let capturado: unknown;
        try {
            guard.canActivate(guardContexto(doctor));
        } catch (error) {
            capturado = error;
        }
        expect((capturado as AppError).statusCode).toBe(403);
    });

    it('el permiso de solo lectura no alcanza para subir', () => {
        const guard = new PermissionsGuard(new Reflector());
        const soloLectura = usuario('consulta', [{ area: AREA, level: 'read' }]);

        let capturado: unknown;
        try {
            guard.canActivate(guardContexto(soloLectura));
        } catch (error) {
            capturado = error;
        }
        expect((capturado as AppError).statusCode).toBe(403);
    });

    it('sin sesión responde 401', () => {
        const guard = new PermissionsGuard(new Reflector());

        let capturado: unknown;
        try {
            guard.canActivate(guardContexto(undefined));
        } catch (error) {
            capturado = error;
        }
        expect((capturado as AppError).statusCode).toBe(401);
    });
});
