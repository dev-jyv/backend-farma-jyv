import { Gs1ParseResult, looksLikeGs1, parseGs1 } from '../utils/gs1';
import { Product } from '../types';
import * as productsRepo from '../repositories/products.repository';
import * as batchesRepo from '../repositories/batches.repository';

export interface ScanResult {
    /** `gs1` cuando el código traía AI; `plain` cuando es un EAN/SKU normal. */
    kind: 'gs1' | 'plain';
    /** Desglose de AI; `null` en un código plano. */
    gs1: Gs1ParseResult | null;
    product: Product | null;
    /**
     * Ítem precargado para la entrada de inventario: es exactamente lo que hoy se
     * teclea a mano (lote y caducidad vienen impresos en la caja).
     */
    entrySuggestion: {
        productId: string | null;
        lotNumber: string | null;
        expiryDate: string | null;
        quantity: number | null;
    };
    /** Lote existente que coincide con producto + lote + caducidad, si ya hay. */
    existingBatchId: string | null;
}

/**
 * Resuelve un código escaneado: GS1-128 / DataMatrix o código plano.
 *
 * El GTIN impreso suele ser GTIN-14 y el catálogo guarda EAN-13, así que se busca
 * por el código normalizado y, si no aparece, por el GTIN tal cual.
 */
export const resolveScannedCode = async (rawCode: string): Promise<ScanResult> => {
    const code = rawCode.trim();
    const isGs1 = looksLikeGs1(code);
    const gs1 = isGs1 ? parseGs1(code) : null;

    const lookupTerms = gs1
        ? [gs1.barcode, gs1.gtin].filter((term): term is string => Boolean(term))
        : [code];

    let product: Product | null = null;
    for (const term of lookupTerms) {
        product = await productsRepo.findProductBySkuOrBarcode(term);
        if (product) {
            break;
        }
    }

    let existingBatchId: string | null = null;
    if (product && gs1?.lotNumber && gs1.expiryDate) {
        const batch = await batchesRepo.findBatchByProductLotAndExpiry(
            product.id,
            gs1.lotNumber,
            gs1.expiryDate,
        );
        existingBatchId = batch?.id ?? null;
    }

    return {
        kind: isGs1 ? 'gs1' : 'plain',
        gs1,
        product,
        entrySuggestion: {
            productId: product?.id ?? null,
            lotNumber: gs1?.lotNumber ?? null,
            expiryDate: gs1?.expiryDate ?? null,
            quantity: gs1?.quantity ?? null,
        },
        existingBatchId,
    };
};
