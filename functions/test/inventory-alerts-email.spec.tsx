import { Timestamp } from 'firebase-admin/firestore';
import { renderToStaticMarkup } from 'react-dom/server';
import { InventoryAlertsEmail } from '../src/emails/inventory-alerts.email';
import { InventoryAlerts, StockAlert } from '../src/types';

/**
 * El correo de alertas llegaba con 211 renglones bajo "Agotados" y por eso
 * nadie lo leía: `outOfStock` recogía todo producto en cero, tuviera mínimo o
 * no. El servicio ya los separa (`outOfStock` vs `unstocked`); lo que se fija
 * aquí es que el correo respete esa división y no vuelva a listar el catálogo.
 */

const agotado = (nombre: string, minStock: number): StockAlert => ({
    productId: nombre,
    productName: nombre,
    sku: `SKU-${nombre}`,
    minStock,
    totalStock: 0,
});

const construirAlertas = (
    outOfStock: StockAlert[],
    lowStock: StockAlert[] = [],
    unstocked: StockAlert[] = [],
) => ({
    generatedAt: Timestamp.now(),
    expired: [],
    expiring: [],
    lowStock,
    outOfStock,
    unstocked,
    totals: {
        expiredBatches: 0,
        expiredUnits: 0,
        expiringBatches: 0,
        expiringUnits: 0,
        lowStockProducts: lowStock.length,
        outOfStockProducts: outOfStock.length,
        unstockedProducts: unstocked.length,
    },
} as InventoryAlerts);

/**
 * Se renderiza con `react-dom/server` y no con `@react-email/render`: ese hace
 * un `await import('react-dom/server')` interno que el runtime CommonJS de Jest
 * no puede resolver sin `--experimental-vm-modules`. En producción funciona
 * igual; aquí solo se comprueba el contenido, y el marcado es el mismo.
 */
const textoDe = async (alerts: InventoryAlerts): Promise<string> => {
    const html = renderToStaticMarkup(<InventoryAlertsEmail alerts={alerts} />);
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;|&#39;/g, '\'')
        .replace(/&middot;|&#183;/g, '·')
        .replace(/\s+/g, ' ');
};

describe('correo de alertas de inventario', () => {
    it('lista como pedido solo lo agotado con mínimo definido', async () => {
        const sinMinimo = Array.from({ length: 205 }, (_, i) => agotado(`FICHA-${i}`, 0));
        const texto = await textoDe(
            construirAlertas([agotado('PARACETAMOL', 24)], [], sinMinimo),
        );

        expect(texto).toContain('PARACETAMOL');
        expect(texto).toContain('pedir 24 u');
        // La ficha de catálogo sin mínimo no se nombra: solo se cuenta.
        expect(texto).not.toContain('FICHA-0');
        expect(texto).toContain('205 productos están en cero');
    });

    it('la cifra principal cuenta lo accionable, no el catálogo en cero', async () => {
        const texto = await textoDe(construirAlertas(
            [agotado('CON-MINIMO', 10)],
            [{
                productId: 'bajo',
                productName: 'OMEPRAZOL',
                sku: 'SKU-OME',
                minStock: 20,
                totalStock: 6,
            }],
            [agotado('SIN-MINIMO', 0)],
        ));

        // 1 agotado con mínimo + 1 bajo el mínimo = 2, no 3.
        expect(texto).toContain('1 agotados · 1 bajo el mínimo');
        expect(texto).toContain('pedir 14 u');
    });

    it('respeta el orden que trae el servicio, no reordena por nombre', async () => {
        // El servicio ya entrega `outOfStock` por mínimo descendente; el correo
        // no debe volver a ordenar (y menos alfabéticamente).
        const texto = await textoDe(construirAlertas([
            agotado('ZZZ-MUCHO', 90),
            agotado('AAA-POCO', 2),
        ]));

        expect(texto.indexOf('ZZZ-MUCHO')).toBeLessThan(texto.indexOf('AAA-POCO'));
    });

    it('ordena lo que está bajo el mínimo por unidades faltantes', async () => {
        const bajo = (nombre: string, totalStock: number, minStock: number): StockAlert => ({
            productId: nombre, productName: nombre, sku: nombre, minStock, totalStock,
        });
        const texto = await textoDe(construirAlertas([], [
            bajo('FALTA-POCO', 9, 12),
            bajo('FALTA-MUCHO', 4, 60),
        ]));

        expect(texto.indexOf('FALTA-MUCHO')).toBeLessThan(texto.indexOf('FALTA-POCO'));
    });

    it('dice cuántos renglones dejó fuera en vez de cortar en silencio', async () => {
        const muchos = Array.from({ length: 12 }, (_, i) => agotado(`PROD-${i}`, 12 - i));
        const texto = await textoDe(construirAlertas(muchos));

        // 12 con mínimo, 8 caben: el corte tiene que ser visible.
        expect(texto).toContain('y 4 productos más');
    });

    it('sin faltantes no inventa una lista de pedido', async () => {
        const texto = await textoDe(construirAlertas([], [], [agotado('SOLO-FICHA', 0)]));

        expect(texto).toContain('Ningún producto con mínimo definido está agotado');
    });
});
