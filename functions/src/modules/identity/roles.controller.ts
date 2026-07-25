import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    createRoleSchema,
    idParamSchema,
    listRolesQuerySchema,
    updateRoleSchema,
} from '../../schemas';
import * as rolesService from '../../services/roles.service';
import { RequirePermission } from './decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateRoleInput = z.infer<typeof createRoleSchema>;
type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

@Controller('roles')
@RequirePermission('users', 'write')
export class RolesController {
    @Get()
    async list(@Query(new ZodValidationPipe(listRolesQuerySchema)) query: ListRolesQuery) {
        const result = await rolesService.listRoles({
            activeOnly: query.activeOnly !== 'false',
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const role = await rolesService.getRole(params.id);
        return { data: role };
    }

    @Post()
    @HttpCode(201)
    async create(@Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleInput) {
        const role = await rolesService.createRole(body);
        return { data: role };
    }

    @Patch(':id')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleInput,
    ) {
        const role = await rolesService.updateRole(params.id, body);
        return { data: role };
    }

    @Delete(':id')
    async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const role = await rolesService.deleteRole(params.id);
        return { data: role };
    }
}
