const currency = new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
});

export const formatCurrency = (value: number): string => currency.format(value);
