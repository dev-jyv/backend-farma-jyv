import {
    Body, Controller, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    createCustomerSchema,
    idParamSchema,
    listCustomersQuerySchema,
    updateCustomerSchema,
} from '../../schemas';
import * as customersService from '../../services/customers.service';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

@Controller('customers')
export class CustomersController {
    @Get()
    @RequirePermission('sales', 'read')
    async list(
        @Query(new ZodValidationPipe(listCustomersQuerySchema)) query: ListCustomersQuery,
    ) {
        const result = await customersService.listCustomers({
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    @RequirePermission('sales', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const customer = await customersService.getCustomer(params.id);
        return { data: customer };
    }

    @Post()
    // Alta de cliente en caja, al momento de cobrar.
    @RequirePermission('pos')
    @HttpCode(201)
    async create(@Body(new ZodValidationPipe(createCustomerSchema)) body: CreateCustomerInput) {
        const customer = await customersService.createCustomer(body);
        return { data: customer };
    }

    @Patch(':id')
    @RequirePermission('pos')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateCustomerSchema)) body: UpdateCustomerInput,
    ) {
        const customer = await customersService.updateCustomer(params.id, body);
        return { data: customer };
    }
}
