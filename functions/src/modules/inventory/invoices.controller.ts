import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
    createInvoiceSchema,
    createSupplierPaymentSchema,
    idParamSchema,
    listInvoicesQuerySchema,
    updateInvoiceAccountingSchema,
    voidSupplierPaymentSchema,
} from '../../schemas';
import * as invoicesService from '../../services/invoices.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
type CreateSupplierPaymentInput = z.infer<typeof createSupplierPaymentSchema>;
type UpdateInvoiceAccountingInput = z.infer<typeof updateInvoiceAccountingSchema>;
type VoidSupplierPaymentInput = z.infer<typeof voidSupplierPaymentSchema>;

/** Ruta con dos ids: la factura y el abono que se cancela. */
const paymentParamsSchema = idParamSchema.extend({ paymentId: idParamSchema.shape.id });
type PaymentParams = z.infer<typeof paymentParamsSchema>;

@Controller('invoices')
export class InvoicesController {
    @Get()
    @RequirePermission('invoices', 'read')
    async list(
        @Query(new ZodValidationPipe(listInvoicesQuerySchema)) query: ListInvoicesQuery,
    ) {
        const result = await invoicesService.listInvoices({
            supplierId: query.supplierId,
            from: query.from,
            to: query.to,
            hasInvoice: query.hasInvoice === 'true'
                ? true
                : query.hasInvoice === 'false'
                    ? false
                    : undefined,
            paymentStatus: query.paymentStatus,
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /** Abonos de una factura, del más reciente al más viejo. */
    @Get(':id/payments')
    @RequirePermission('invoices', 'read')
    async listPayments(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const payments = await invoicesService.listPayments(params.id);
        return { data: payments };
    }

    @Post(':id/payments')
    @RequirePermission('invoices')
    @HttpCode(201)
    async addPayment(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(createSupplierPaymentSchema)) body: CreateSupplierPaymentInput,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await invoicesService.registerPayment(params.id, {
            ...body,
            userId: user.uid,
            roleSlug: user.role.slug,
            // La etiqueta la pone el servidor: es quién firma la salida de
            // dinero, así que aceptarla del cuerpo permitiría atribuirla a otro.
            userLabel: user.displayName || user.email,
        });
        return { data: result.payment, invoice: result.invoice };
    }

    /** Cancela un abono con su contrapartida; el original se conserva. */
    @Post(':id/payments/:paymentId/void')
    @RequirePermission('invoices')
    async voidPayment(
        @Param(new ZodValidationPipe(paymentParamsSchema)) params: PaymentParams,
        @Body(new ZodValidationPipe(voidSupplierPaymentSchema)) body: VoidSupplierPaymentInput,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await invoicesService.voidPayment(params.paymentId, {
            reason: body.reason,
            userId: user.uid,
            roleSlug: user.role.slug,
            userLabel: user.displayName || user.email,
        });
        return { data: result.reversal, invoice: result.invoice };
    }

    /** Corrección contable: solo vencimiento y desglose de impuestos. */
    @Patch(':id')
    @RequirePermission('invoices')
    async updateAccounting(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateInvoiceAccountingSchema))
            body: UpdateInvoiceAccountingInput,
        @CurrentUser() user: AuthUser,
    ) {
        const invoice = await invoicesService.updateAccounting(params.id, {
            ...body,
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: invoice };
    }

    @Get(':id')
    @RequirePermission('invoices', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const invoice = await invoicesService.getInvoice(params.id);
        return { data: invoice };
    }

    @Post()
    @RequirePermission('invoices')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceInput,
        @CurrentUser() user: AuthUser,
    ) {
        const invoice = await invoicesService.createInvoice({ ...body, userId: user.uid });
        return { data: invoice };
    }
}
