import { forbidden } from '../utils/errors';
import * as pointOrdersRepo from '../repositories/point-orders.repository';

export const rememberPointOrder = (
    orderId: string,
    cashierId: string,
): Promise<void> => pointOrdersRepo.recordPointOrderOwner(orderId, cashierId);

export const assertCanCancelPointOrder = (
    ownerId: string | null,
    user: { uid: string; roleSlug: string },
): void => {
    if (!ownerId) {
        throw forbidden('Esta orden no pertenece a un cobro de esta caja');
    }
    if (ownerId !== user.uid && user.roleSlug !== 'admin') {
        throw forbidden('Solo quien creó la orden puede cancelarla');
    }
};

export const assertCallerCanCancelPointOrder = async (
    orderId: string,
    user: { uid: string; roleSlug: string },
): Promise<void> => {
    const ownerId = await pointOrdersRepo.getPointOrderOwner(orderId);
    assertCanCancelPointOrder(ownerId, user);
};
