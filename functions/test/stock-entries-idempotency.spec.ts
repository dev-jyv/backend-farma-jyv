import { Timestamp } from 'firebase-admin/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as inventoryService from '../src/services/inventory.service';
import * as productsService from '../src/services/products.service';
import * as stockEntriesService from '../src/services/stock-entries.service';
import { db } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const fixtures = async () => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    const product = await productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: 10,
        minStock: 1,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        suppliers: [],
    });
    const supplier = await suppliersRepo.createSupplier({
        name: unique('Proveedor'),
        isActive: true,
    });
    const invoice = await invoicesRepo.createInvoice(
        invoicesRepo.generateInvoiceId(),
        {
            supplierId: supplier.id,
            invoiceNumber: unique('FAC'),
            invoiceDate: Timestamp.now(),
            totalAmount: 100,
            hasInvoice: false,
        },
        'test-user',
    );
    return { product, invoice };
};

/**
 * Regresión (QA-5): el alta de stock no tenía idempotencia. El fallo real no es
 * el doble clic —el formulario se deshabilita— sino el reintento de la cola: la
 * entrada se aplicó, la respuesta se perdió en la red y el flush siguiente la
 * volvía a mandar. Quedaba un segundo lote con el mismo número y la misma
 * factura: existencias que no existen y que nadie cuadra contra el papel.
 */
describe('createStockEntry: idempotencia', () => {
    it('el reintento con la misma llave devuelve la entrada y no duplica el lote', async () => {
        const { product, invoice } = await fixtures();
        const entrada = {
            invoiceId: invoice.id,
            lotNumber: 'LOTE-IDEM',
            expiryDate: '2030-01-31',
            quantity: 5,
            productId: product.id,
            userId: 'uid-cajero',
            roleSlug: 'cashier',
            idempotencyKey: unique('entrada'),
        };

        const primera = await stockEntriesService.createStockEntry(entrada);
        const reintento = await stockEntriesService.createStockEntry(entrada);

        expect(reintento.entry.id).toBe(primera.entry.id);
        const lotes = await batchesRepo.listBatchesByProduct(product.id);
        expect(lotes.filter((lote) => lote.lotNumber === 'LOTE-IDEM')).toHaveLength(1);
        // Y el stock quedó en 5, no en 10.
        expect((await productsService.getProduct(product.id)).stock).toBe(5);
    });

    it('sin llave (cliente viejo) sigue aplicando la entrada', async () => {
        const { product, invoice } = await fixtures();

        await stockEntriesService.createStockEntry({
            invoiceId: invoice.id,
            lotNumber: 'LOTE-SIN-LLAVE',
            expiryDate: '2030-01-31',
            quantity: 3,
            productId: product.id,
            userId: 'uid-cajero',
            roleSlug: 'cashier',
        });

        expect((await productsService.getProduct(product.id)).stock).toBe(3);
    });

    it('dos llaves distintas sí registran dos entradas', async () => {
        const { product, invoice } = await fixtures();
        const base = {
            invoiceId: invoice.id,
            lotNumber: 'LOTE-DOS',
            expiryDate: '2030-01-31',
            quantity: 2,
            productId: product.id,
            userId: 'uid-cajero',
            roleSlug: 'cashier',
        };

        await stockEntriesService.createStockEntry({ ...base, idempotencyKey: unique('a') });
        await stockEntriesService.createStockEntry({ ...base, idempotencyKey: unique('b') });

        expect((await productsService.getProduct(product.id)).stock).toBe(4);
    });
});

/**
 * Regresión: la llave se reserva antes de validar y nadie la liberaba. Cualquier
 * rechazo normal dejaba la entrada para siempre en 409 "quedó a medio registrar",
 * con "Reintentar" reenviando la misma llave, aunque no se hubiera aplicado nada.
 */
describe('createStockEntry: llave reservada sin entrada', () => {
    const MEDIO_REGISTRAR = /medio registrar/;
    const HACE_UNA_HORA = new Date(Date.now() - 60 * 60 * 1000);

    const entradaCon = async (lotNumber: string) => {
        const { product, invoice } = await fixtures();
        return {
            product,
            entrada: {
                invoiceId: invoice.id,
                lotNumber,
                expiryDate: '2030-01-31',
                quantity: 5,
                productId: product.id,
                userId: 'uid-cajero',
                roleSlug: 'cashier',
                idempotencyKey: unique('entrada'),
            },
        };
    };

    const reservar = (key: string, createdAt: Date) => db()
        .collection('stockEntryIdempotencyKeys')
        .doc(`uid-cajero:${key}`)
        .set({ userId: 'uid-cajero', createdAt });

    it('un rechazo de validación libera la llave: el reintento dice el motivo real', async () => {
        const { entrada } = await entradaCon('LOTE-RECHAZO');
        const invalida = { ...entrada, quantity: 0 };

        await expect(stockEntriesService.createStockEntry(invalida))
            .rejects.toThrow('La cantidad debe ser mayor a cero');
        await expect(stockEntriesService.createStockEntry(invalida))
            .rejects.toThrow('La cantidad debe ser mayor a cero');
    });

    it('tras un rechazo, la misma llave registra la entrada una sola vez', async () => {
        const { entrada, product } = await entradaCon('LOTE-CORREGIDO');

        await expect(stockEntriesService.createStockEntry({ ...entrada, quantity: 0 }))
            .rejects.toThrow('La cantidad debe ser mayor a cero');
        await stockEntriesService.createStockEntry(entrada);
        await stockEntriesService.createStockEntry(entrada);

        expect((await productsService.getProduct(product.id)).stock).toBe(5);
    });

    it('un error que no es de negocio conserva la reserva: pudo haberse aplicado', async () => {
        const { entrada } = await entradaCon('LOTE-AMBIGUO');
        const spy = jest.spyOn(inventoryService, 'recordEntry')
            .mockRejectedValueOnce(new Error('DEADLINE_EXCEEDED'));

        await expect(stockEntriesService.createStockEntry(entrada))
            .rejects.toThrow('DEADLINE_EXCEEDED');
        spy.mockRestore();

        await expect(stockEntriesService.createStockEntry(entrada))
            .rejects.toThrow(MEDIO_REGISTRAR);
    });

    it('reserva vieja sin lote en el servidor: nunca se aplicó y se registra', async () => {
        const { entrada, product } = await entradaCon('LOTE-HUERFANO');
        await reservar(entrada.idempotencyKey, HACE_UNA_HORA);

        await stockEntriesService.createStockEntry(entrada);
        await stockEntriesService.createStockEntry(entrada);

        expect((await productsService.getProduct(product.id)).stock).toBe(5);
    });

    it('reserva vieja con ese lote en el servidor: no duplica y pide revisar', async () => {
        const { entrada, product } = await entradaCon('LOTE-APLICADO');
        await stockEntriesService.createStockEntry({ ...entrada, idempotencyKey: unique('otra') });
        await reservar(entrada.idempotencyKey, HACE_UNA_HORA);

        await expect(stockEntriesService.createStockEntry(entrada))
            .rejects.toThrow(MEDIO_REGISTRAR);
        expect((await productsService.getProduct(product.id)).stock).toBe(5);
    });

    it('reserva reciente: puede seguir en curso y no se toca', async () => {
        const { entrada, product } = await entradaCon('LOTE-EN-CURSO');
        await reservar(entrada.idempotencyKey, new Date());

        await expect(stockEntriesService.createStockEntry(entrada))
            .rejects.toThrow(MEDIO_REGISTRAR);
        expect((await productsService.getProduct(product.id)).stock).toBe(0);
    });

    it('alta que dejó el producto sin lote: lo reutiliza, no choca por SKU', async () => {
        const { entrada, product } = await entradaCon('LOTE-ALTA');
        const { productId: _sinProductId, ...sinId } = entrada;
        await reservar(entrada.idempotencyKey, HACE_UNA_HORA);

        await stockEntriesService.createStockEntry({
            ...sinId,
            product: {
                name: product.name,
                sku: product.sku,
                categoryId: product.categoryId,
                unit: product.unit,
                salePrice: product.salePrice,
                minStock: product.minStock,
                hasIva: product.hasIva,
                hasIvaZero: product.hasIvaZero,
                hasIeps: product.hasIeps,
            } as never,
        });

        expect((await productsService.getProduct(product.id)).stock).toBe(5);
    });
});
