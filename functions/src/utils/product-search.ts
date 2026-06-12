import { Product } from '../types';

export const matchesProductSearch = (
    product: Pick<Product, 'name' | 'sku' | 'barcode' | 'activeIngredient'>,
    term: string,
): boolean => {
    const normalized = term.toLowerCase();
    return (
        product.name.toLowerCase().includes(normalized) ||
        (product.sku?.toLowerCase().includes(normalized) ?? false) ||
        (product.barcode?.toLowerCase().includes(normalized) ?? false) ||
        (product.activeIngredient?.toLowerCase().includes(normalized) ?? false)
    );
};
