#!/usr/bin/env node
/**
 * Genera `test/coupons-engine.cases.json`, los casos dorados del motor de
 * cupones (SPEC 47). El archivo se **copia** tal cual al POS
 * (`src/app/shared/utils/coupons-engine.cases.json`) y `check:promo-engine`
 * compara los sha256: no se regenera en el otro repo.
 *
 * El esperado se calcula aquí con una implementación independiente y literal
 * del contrato, no importando `src/utils/coupons.ts`: si el motor y este
 * script coinciden, coinciden dos lecturas del mismo contrato. Determinista
 * (sin aleatorios), así que regenerar sin cambios produce el mismo archivo.
 *
 *   node scripts/generate-coupons-engine-cases.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test/coupons-engine.cases.json');

/** Lectura literal del contrato de SPEC 47. */
const expectedFor = (coupon, lines) => {
    const zero = { lines: lines.map(() => 0), saleCents: 0, totalCents: 0 };
    const d = coupon.discount;
    if (!d || (d.type !== 'percent' && d.type !== 'amount')) {
        return zero;
    }
    const valid = d.type === 'percent'
        ? typeof d.percent === 'number' && Number.isFinite(d.percent) && d.percent > 0
        : typeof d.amountCents === 'number' && Number.isFinite(d.amountCents) &&
            d.amountCents > 0;
    const rule = (base, units) => {
        if (base <= 0 || !valid) {
            return 0;
        }
        const raw = d.type === 'percent'
            ? Math.round(base * d.percent / 100)
            : Math.round(d.amountCents * units);
        return Math.max(0, Math.min(raw, base));
    };
    if (coupon.scope === 'product') {
        const ids = Array.isArray(coupon.productIds) ? coupon.productIds : [];
        const per = lines.map((line) => (ids.includes(line.productId) && !line.hasPromotion
            ? rule(line.netCents, line.pieces)
            : 0));
        return { lines: per, saleCents: 0, totalCents: per.reduce((a, b) => a + b, 0) };
    }
    if (coupon.scope === 'sale') {
        const base = lines.reduce((sum, line) => sum + line.netCents, 0);
        if (coupon.minPurchaseCents !== null && coupon.minPurchaseCents !== undefined &&
            base < coupon.minPurchaseCents) {
            return zero;
        }
        const sale = rule(base, 1);
        return { lines: lines.map(() => 0), saleCents: sale, totalCents: sale };
    }
    return zero;
};

const line = (productId, pieces, netCents, hasPromotion = false) =>
    ({ productId, pieces, netCents, hasPromotion });
const productCoupon = (productIds, discount) =>
    ({ scope: 'product', productIds, discount, minPurchaseCents: null });
const saleCoupon = (discount, minPurchaseCents = null) =>
    ({ scope: 'sale', productIds: [], discount, minPurchaseCents });
const pct = (percent) => ({ type: 'percent', percent });
const amt = (amountCents) => ({ type: 'amount', amountCents });

const cases = [];
const add = (name, coupon, lines) => {
    cases.push({ name, coupon, lines, expected: expectedFor(coupon, lines) });
};

// --- Producto: porcentaje sobre netos variados (redondeo a medio centavo hacia arriba).
for (const percent of [1, 10, 12.5, 33, 50, 90]) {
    for (const net of [1, 105, 1005, 33333]) {
        add(`producto ${percent}% sobre neto ${net}`, productCoupon(['p1'], pct(percent)), [
            line('p1', 1, net),
        ]);
    }
}

// --- Producto: monto por pieza, con y sin tope en el neto.
for (const [amount, pieces, net] of [
    [500, 1, 3500], [500, 3, 10500], [1000, 2, 1500], [999, 10, 9000],
    [1, 1000, 180000], [5000, 1, 4999], [250, 20, 36000], [3333, 3, 9999],
]) {
    add(`producto $${amount / 100} x ${pieces} pzas sobre neto ${net}`,
        productCoupon(['p1'], amt(amount)), [line('p1', pieces, net)]);
}

// --- Producto: elegibilidad.
add('producto: solo las partidas de productIds', productCoupon(['p1', 'p3'], pct(10)), [
    line('p1', 2, 7000), line('p2', 1, 5000), line('p3', 4, 12345),
]);
add('producto: la partida con promoción no es elegible', productCoupon(['p1', 'p2'], pct(10)), [
    line('p1', 2, 6000, true), line('p2', 1, 3500),
]);
add('producto: todas las elegibles con promoción → 0', productCoupon(['p1'], pct(20)), [
    line('p1', 2, 6000, true), line('p9', 1, 3500),
]);
add('producto: ningún producto del cupón en la venta', productCoupon(['p7'], amt(500)), [
    line('p1', 1, 3500), line('p2', 2, 7000),
]);
add('producto: mismo producto en dos partidas (pieza y caja)', productCoupon(['p1'], amt(200)), [
    line('p1', 3, 6000), line('p1', 20, 36000),
]);
add('producto: monto sobre caja de 10 (piezas = cajas × 10)', productCoupon(['p1'], amt(150)), [
    line('p1', 20, 36000),
]);
add('producto: neto cero', productCoupon(['p1'], pct(50)), [line('p1', 1, 0)]);
add('producto: sin partidas', productCoupon(['p1'], pct(50)), []);
add('producto: 50 productos, partidas mezcladas',
    productCoupon(Array.from({ length: 50 }, (_, i) => `p${i}`), pct(15)),
    [line('p0', 1, 1999), line('p49', 2, 2501), line('p50', 1, 9999), line('p25', 3, 3)]);
add('producto: porcentaje que redondea a 0', productCoupon(['p1'], pct(1)), [line('p1', 1, 49)]);
add('producto: porcentaje que redondea a 1', productCoupon(['p1'], pct(1)), [line('p1', 1, 50)]);
add('producto: monto sobre varias partidas con tope distinto', productCoupon(['a', 'b'], amt(700)), [
    line('a', 1, 500), line('b', 2, 5000), line('c', 5, 1000),
]);

// --- Venta: porcentaje y monto sobre la base.
for (const percent of [5, 10, 17.5, 90]) {
    add(`venta ${percent}% sin mínimo`, saleCoupon(pct(percent)), [
        line('p1', 2, 7000), line('p2', 1, 2550, true), line('svc', 1, 25000),
    ]);
}
for (const amount of [5000, 30000, 34550, 50000]) {
    add(`venta $${amount / 100} sin mínimo`, saleCoupon(amt(amount)), [
        line('p1', 2, 7000), line('p2', 1, 2550, true), line('svc', 1, 25000),
    ]);
}

// --- Venta: compra mínima (frontera exacta, debajo, arriba).
for (const [minimum, label] of [[50000, 'exacto'], [50001, 'un centavo debajo'], [10000, 'holgado']]) {
    add(`venta mínimo ${label}`, saleCoupon(amt(5000), minimum), [
        line('p1', 1, 30000), line('p2', 4, 20000),
    ]);
}
add('venta: mínimo no alcanzado → todo 0', saleCoupon(pct(10), 100000), [line('p1', 1, 99999)]);
add('venta: mínimo cero', saleCoupon(pct(10), 0), [line('p1', 1, 1)]);
add('venta: sin partidas', saleCoupon(amt(1000)), []);
add('venta: base cero', saleCoupon(amt(1000)), [line('p1', 1, 0)]);
add('venta: las promociones sí cuentan en la base', saleCoupon(pct(10)), [
    line('p1', 2, 6000, true), line('p2', 2, 6000, true),
]);
add('venta: monto mayor que la base, tope en la base', saleCoupon(amt(99999)), [
    line('p1', 1, 1234),
]);
add('venta: porcentaje con medio centavo', saleCoupon(pct(10)), [line('p1', 1, 1005)]);
add('venta: productIds se ignoran en alcance venta',
    { scope: 'sale', productIds: ['p1'], discount: pct(10), minPurchaseCents: null },
    [line('p1', 1, 1000), line('p2', 1, 1000)]);

// --- Formas desconocidas: cero, nunca error.
add('alcance desconocido', { scope: 'category', productIds: ['p1'], discount: pct(10),
    minPurchaseCents: null }, [line('p1', 1, 1000)]);
add('tipo de descuento desconocido', { scope: 'sale', productIds: [],
    discount: { type: 'bogus', value: 10 }, minPurchaseCents: null }, [line('p1', 1, 1000)]);
add('descuento ausente', { scope: 'product', productIds: ['p1'], discount: null,
    minPurchaseCents: null }, [line('p1', 1, 1000)]);
add('porcentaje no numérico', productCoupon(['p1'], { type: 'percent', percent: '10' }), [
    line('p1', 1, 1000),
]);
add('monto cero', saleCoupon(amt(0)), [line('p1', 1, 1000)]);
add('monto negativo', productCoupon(['p1'], amt(-500)), [line('p1', 1, 1000)]);
add('productIds ausente en alcance producto',
    { scope: 'product', discount: pct(10), minPurchaseCents: null }, [line('p1', 1, 1000)]);

if (cases.length < 60) {
    throw new Error(`Se esperaban al menos 60 casos y hay ${cases.length}`);
}
const names = new Set(cases.map((entry) => entry.name));
if (names.size !== cases.length) {
    throw new Error('Hay nombres de caso repetidos');
}

writeFileSync(out, `${JSON.stringify({ cases }, null, 2)}\n`);
console.log(`✓ ${cases.length} casos → ${out}`);
