import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    createCategorySchema,
    idParamSchema,
    listCategoriesQuerySchema,
    updateCategorySchema,
} from '../../schemas';
import * as categoriesService from '../../services/categories.service';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateCategoryInput = z.infer<typeof createCategorySchema>;
type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

@Controller('categories')
export class CategoriesController {
    @Get()
    @RequirePermission('categories', 'read')
    async list(
        @Query(new ZodValidationPipe(listCategoriesQuerySchema)) query: ListCategoriesQuery,
    ) {
        const result = await categoriesService.listCategories({
            activeOnly: query.activeOnly !== 'false',
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    @RequirePermission('categories', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const category = await categoriesService.getCategory(params.id);
        return { data: category };
    }

    @Post()
    @RequirePermission('categories')
    @HttpCode(201)
    async create(@Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput) {
        const category = await categoriesService.createCategory(body);
        return { data: category };
    }

    @Patch(':id')
    @RequirePermission('categories')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
    ) {
        const category = await categoriesService.updateCategory(params.id, body);
        return { data: category };
    }

    @Delete(':id')
    @RequirePermission('categories')
    async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const category = await categoriesService.deleteCategory(params.id);
        return { data: category };
    }
}
