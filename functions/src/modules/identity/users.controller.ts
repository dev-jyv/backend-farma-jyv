import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    idParamSchema,
    listUsersQuerySchema,
    registerStaffSchema,
    updateUserSchema,
} from '../../schemas';
import * as authService from '../../services/auth.service';
import * as usersService from '../../services/users.service';
import { AuthUser } from '../../types';
import { CurrentUser } from './decorators/current-user.decorator';
import { RequirePermission } from './decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type RegisterStaffInput = z.infer<typeof registerStaffSchema>;
type UpdateUserInput = z.infer<typeof updateUserSchema>;

@Controller('users')
@RequirePermission('users', 'write')
export class UsersController {
    @Get()
    async list(@Query(new ZodValidationPipe(listUsersQuerySchema)) query: ListUsersQuery) {
        const result = await usersService.listUsers({
            activeOnly: query.activeOnly === 'true',
            roleId: query.roleId,
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const user = await usersService.getUser(params.id);
        return { data: user };
    }

    @Post()
    @HttpCode(201)
    async register(
        @Body(new ZodValidationPipe(registerStaffSchema)) body: RegisterStaffInput,
    ) {
        const user = await authService.registerStaff(body);
        return { data: user };
    }

    @Patch(':id')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserInput,
        @CurrentUser() actor: AuthUser,
    ) {
        const user = await usersService.updateUser(params.id, body, actor.uid);
        return { data: user };
    }

    @Delete(':id')
    async remove(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() actor: AuthUser,
    ) {
        const user = await usersService.deactivateUser(params.id, actor.uid);
        return { data: user };
    }
}
