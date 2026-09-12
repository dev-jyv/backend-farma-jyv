/**
 * Comprobantes de factura en Cloudflare R2.
 *
 * Lo que se fija aquí es el **enrutado por prefijo**, que es toda la migración:
 * `facturas/` va a R2, `uploads/` sigue en Firebase Storage. Importa porque los
 * comprobantes subidos antes de R2 viven en `uploads/` y tienen que seguir
 * abriéndose; sondear los dos proveedores en cada lectura sería un viaje de red
 * de más y un fallo silencioso cuando el sondeo se equivoca.
 *
 * Lo clínico también está en `uploads/` y NO se mueve: es dato sensible de
 * paciente (NOM-004).
 */

const r2 = {
    putObject: jest.fn(async () => undefined),
    headObject: jest.fn(async () => ({ mimeType: 'application/pdf' })),
    presignGetUrl: jest.fn(async () => 'https://r2.example/firmada'),
};
jest.mock('../src/utils/r2', () => r2);

const gcsFile = {
    save: jest.fn(async () => undefined),
    getMetadata: jest.fn(async () => [{ contentType: 'image/png', metadata: {} }]),
    setMetadata: jest.fn(async () => undefined),
    getSignedUrl: jest.fn(async () => ['https://gcs.example/firmada']),
};
const bucket = { name: 'farma-jyv.appspot.com', file: jest.fn(() => gcsFile) };
jest.mock('firebase-admin/storage', () => ({ getStorage: () => ({ bucket: () => bucket }) }));

import {
    R2_PREFIX,
    getFileMetadata,
    getFileUrl,
    getSignedFileUrl,
    invoicePrefix,
    isR2Path,
    uploadFile,
} from '../src/utils/storage';

const RUTA_R2 = 'facturas/abc123/factura.pdf';
const RUTA_GCS = 'uploads/abc123/estudio.png';

const conR2 = <T>(trabajo: () => T): T => {
    const previo = { ...process.env };
    process.env.R2_ACCOUNT_ID = '37e1c56124a03b79da9218615b20f8ff';
    process.env.R2_BUCKET = 'farma-jyv-facturas';
    process.env.R2_ACCESS_KEY_ID = 'llave-de-prueba';
    process.env.R2_SECRET_ACCESS_KEY = 'secreto-de-prueba';
    try {
        return trabajo();
    } finally {
        process.env = previo;
    }
};

const sinR2 = <T>(trabajo: () => T): T => {
    const previo = { ...process.env };
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_BUCKET;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    try {
        return trabajo();
    } finally {
        process.env = previo;
    }
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('isR2Path', () => {
    it('reconoce los comprobantes de factura', () => {
        expect(isR2Path(RUTA_R2)).toBe(true);
    });

    it('no reclama lo que vive en Firebase Storage', () => {
        expect(isR2Path(RUTA_GCS)).toBe(false);
    });

    it('el prefijo es exactamente `facturas/`, no cualquier cosa que empiece parecido', () => {
        // `facturas-viejas/...` no es el prefijo: sin la barra, un bucket ajeno
        // con nombre parecido se leería del proveedor equivocado.
        expect(isR2Path('facturas-viejas/x.pdf')).toBe(false);
        expect(R2_PREFIX).toBe('facturas/');
    });
});

describe('subida', () => {
    it('un comprobante va a R2 y no toca Firebase Storage', async () => {
        await uploadFile(RUTA_R2, Buffer.from('x'), 'application/pdf');

        expect(r2.putObject).toHaveBeenCalledWith(RUTA_R2, expect.any(Buffer), 'application/pdf');
        expect(gcsFile.save).not.toHaveBeenCalled();
    });

    it('lo demás sigue yendo a Firebase Storage', async () => {
        await uploadFile(RUTA_GCS, Buffer.from('x'), 'image/png');

        expect(gcsFile.save).toHaveBeenCalled();
        expect(r2.putObject).not.toHaveBeenCalled();
    });
});

describe('lectura', () => {
    it('la URL de un comprobante la firma R2', async () => {
        expect(await getFileUrl(RUTA_R2)).toBe('https://r2.example/firmada');
        expect(r2.presignGetUrl).toHaveBeenCalledWith(RUTA_R2);
    });

    /**
     * El caso que hace innecesaria una migración de datos: un comprobante
     * subido antes de R2 sigue en `uploads/` y tiene que seguir abriéndose.
     */
    it('un comprobante viejo se sigue leyendo de Firebase Storage', async () => {
        const url = await getFileUrl(RUTA_GCS);

        expect(url).toContain('firebasestorage.googleapis.com');
        expect(r2.presignGetUrl).not.toHaveBeenCalled();
    });

    it('`getSignedFileUrl` respeta la caducidad pedida también en R2', async () => {
        await getSignedFileUrl(RUTA_R2, 5);

        expect(r2.presignGetUrl).toHaveBeenCalledWith(RUTA_R2, 5);
    });

    it('los metadatos de un comprobante salen de R2', async () => {
        const meta = await getFileMetadata(RUTA_R2);

        expect(meta).toEqual({ fileName: 'factura.pdf', mimeType: 'application/pdf' });
        expect(r2.headObject).toHaveBeenCalledWith(RUTA_R2);
    });

    it('los metadatos de lo viejo salen de Firebase Storage', async () => {
        const meta = await getFileMetadata(RUTA_GCS);

        expect(meta).toEqual({ fileName: 'estudio.png', mimeType: 'image/png' });
        expect(r2.headObject).not.toHaveBeenCalled();
    });
});

describe('invoicePrefix', () => {
    it('con R2 configurado, los comprobantes nuevos van a `facturas/`', () => {
        expect(conR2(() => invoicePrefix())).toBe('facturas/');
    });

    /**
     * Sin credenciales de R2 la factura se registra igual, con el archivo en
     * Firebase Storage. Tumbar la caja porque un secreto no está puesto sería
     * peor, y es lo que deja el emulador funcionando sin credenciales.
     */
    it('sin configurar, cae en Firebase Storage en vez de fallar', () => {
        expect(sinR2(() => invoicePrefix())).toBe('uploads/');
    });
});
