import { createInvoiceSchema } from '../src/schemas/inventory';

/**
 * El comprobante de una factura es **opcional**: se registra el documento aunque
 * el archivo llegue después, o nunca (el proveedor solo dejó ticket).
 *
 * Lo que no puede aflojarse es la ruta cuando sí viene: `fileUrl` es una ruta de
 * Storage que el cliente propone, y sin el prefijo `uploads/` apuntaría a
 * cualquier objeto del bucket.
 */

jest.mock('../src/utils/storage', () => ({
    getFileMetadata: jest.fn(async () => ({ fileName: 'factura.pdf', mimeType: 'application/pdf' })),
    getFileUrl: jest.fn(async () => 'https://signed.example/factura.pdf'),
}));

import { getFileMetadata } from '../src/utils/storage';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import * as invoicesService from '../src/services/invoices.service';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const base = {
    supplierId: 's-1',
    invoiceNumber: 'A-100',
    invoiceDate: '2026-09-05',
    totalAmount: 100,
    hasInvoice: true,
};

describe('createInvoiceSchema: el comprobante es opcional', () => {
    it('acepta una factura sin comprobante', () => {
        const resultado = createInvoiceSchema.safeParse(base);

        expect(resultado.success).toBe(true);
        if (resultado.success) {
            expect(resultado.data.fileUrl).toBeUndefined();
        }
    });

    it('acepta una factura con comprobante', () => {
        const resultado = createInvoiceSchema.safeParse({ ...base, fileUrl: 'uploads/x/factura.pdf' });

        expect(resultado.success).toBe(true);
    });

    it('sigue rechazando una ruta fuera de `uploads/`', () => {
        // Sin esto, `fileUrl` nombra cualquier objeto del bucket.
        const resultado = createInvoiceSchema.safeParse({ ...base, fileUrl: 'otros/secreto.pdf' });

        expect(resultado.success).toBe(false);
    });

    it('sigue rechazando una travesía de rutas', () => {
        const resultado = createInvoiceSchema.safeParse({
            ...base,
            fileUrl: '../uploads/otro.pdf',
        });

        expect(resultado.success).toBe(false);
    });

    it.each(['supplierId', 'invoiceNumber', 'invoiceDate', 'totalAmount', 'hasInvoice'])(
        'el resto sigue siendo obligatorio: falta "%s"',
        (campo) => {
            const cuerpo: Record<string, unknown> = { ...base };
            delete cuerpo[campo];

            expect(createInvoiceSchema.safeParse(cuerpo).success).toBe(false);
        },
    );
});

describe('createInvoice: persistencia sin comprobante', () => {
    let supplierId: string;

    beforeAll(async () => {
        const supplier = await suppliersRepo.createSupplier({ name: unique('Proveedor'), isActive: true });
        supplierId = supplier.id;
    });

    beforeEach(() => {
        (getFileMetadata as jest.Mock).mockClear();
    });

    it('registra la factura y no escribe los campos del archivo', async () => {
        const invoice = await invoicesService.createInvoice({
            supplierId,
            invoiceNumber: unique('FAC'),
            invoiceDate: '2026-09-05',
            totalAmount: 250,
            hasInvoice: true,
            userId: 'u-1',
        });

        // Escribir `undefined` en Firestore es un error de escritura, no un campo
        // vacío: los tres campos del archivo tienen que estar ausentes.
        expect(invoice.storagePath).toBeUndefined();
        expect(invoice.fileName).toBeUndefined();
        expect(invoice.mimeType).toBeUndefined();
        expect(invoice.totalAmount).toBe(250);
    });

    it('sin comprobante no se consulta el Storage', async () => {
        await invoicesService.createInvoice({
            supplierId,
            invoiceNumber: unique('FAC'),
            invoiceDate: '2026-09-05',
            totalAmount: 10,
            hasInvoice: false,
            userId: 'u-1',
        });

        expect(getFileMetadata).not.toHaveBeenCalled();
    });

    it('con comprobante sí guarda ruta, nombre y tipo', async () => {
        const invoice = await invoicesService.createInvoice({
            supplierId,
            invoiceNumber: unique('FAC'),
            invoiceDate: '2026-09-05',
            totalAmount: 10,
            hasInvoice: true,
            fileUrl: 'uploads/u-1/factura.pdf',
            userId: 'u-1',
        });

        expect(invoice.storagePath).toBe('uploads/u-1/factura.pdf');
        expect(invoice.fileName).toBe('factura.pdf');
        expect(invoice.mimeType).toBe('application/pdf');
        expect(getFileMetadata).toHaveBeenCalledWith('uploads/u-1/factura.pdf');
    });

    it('una ruta fuera de `uploads/` se rechaza también en el servicio', async () => {
        // Defensa en profundidad: el schema cubre HTTP, no a otros llamadores.
        await expect(
            invoicesService.createInvoice({
                supplierId,
                invoiceNumber: unique('FAC'),
                invoiceDate: '2026-09-05',
                totalAmount: 10,
                hasInvoice: true,
                fileUrl: 'otros/secreto.pdf',
                userId: 'u-1',
            }),
        ).rejects.toThrow(/ruta del archivo no es válida/i);
    });

    it('el detalle de una factura sin comprobante no trae `fileUrl`', async () => {
        const creada = await invoicesService.createInvoice({
            supplierId,
            invoiceNumber: unique('FAC'),
            invoiceDate: '2026-09-05',
            totalAmount: 10,
            hasInvoice: false,
            userId: 'u-1',
        });

        // La pantalla de detalle decide con esto si ofrece el botón de descarga.
        const detalle = await invoicesService.getInvoice(creada.id);

        expect(detalle.fileUrl).toBeUndefined();
    });
});
