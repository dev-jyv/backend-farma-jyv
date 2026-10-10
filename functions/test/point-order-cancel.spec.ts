import { assertCanCancelPointOrder } from '../src/services/point-orders.service';
import { AppError } from '../src/utils/errors';

describe('assertCanCancelPointOrder', () => {
    const cajero = { uid: 'uid-cajero', roleSlug: 'cashier' };

    it('deja cancelar al cajero que creó la orden', () => {
        expect(() => assertCanCancelPointOrder('uid-cajero', cajero)).not.toThrow();
    });

    it('deja cancelar al admin una orden de otro cajero', () => {
        expect(() => assertCanCancelPointOrder('uid-cajero', {
            uid: 'uid-admin',
            roleSlug: 'admin',
        })).not.toThrow();
    });

    it('rechaza una orden que esta caja no creó', () => {
        expect(() => assertCanCancelPointOrder(null, cajero)).toThrow(AppError);
        expect(() => assertCanCancelPointOrder(null, cajero)).toThrow(/no pertenece/);
    });

    it('rechaza la orden de otro cajero', () => {
        expect(() => assertCanCancelPointOrder('uid-otro', cajero)).toThrow(/quien creó la orden/);
    });
});
