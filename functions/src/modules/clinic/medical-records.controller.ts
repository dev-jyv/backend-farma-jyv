import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import {
    attachmentParamsSchema,
    createMedicalRecordSchema,
    idParamSchema,
    listMedicalRecordsQuerySchema,
    updateMedicalRecordSchema,
} from '../../schemas';
import * as recordsService from '../../services/medical-records.service';
import { AuthUser, ClinicActor } from '../../types';
import { badRequest } from '../../utils/errors';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FileUploadInterceptor } from '../uploads/file-upload.interceptor';

type ListQuery = z.infer<typeof listMedicalRecordsQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type AttachmentParams = z.infer<typeof attachmentParamsSchema>;
type CreateInput = z.infer<typeof createMedicalRecordSchema>;
type UpdateInput = z.infer<typeof updateMedicalRecordSchema>;

const toActor = (user: AuthUser): ClinicActor => ({
    userId: user.uid,
    displayName: user.displayName,
    roleSlug: user.role.slug,
});

@Controller('medical-records')
export class MedicalRecordsController {
    @Get()
    @RequirePermission('medicalRecords', 'read')
    async list(@Query(new ZodValidationPipe(listMedicalRecordsQuerySchema)) query: ListQuery) {
        const result = await recordsService.listMedicalRecords({
            patientId: query.patientId,
            doctorId: query.doctorId,
            type: query.type,
            from: query.from,
            to: query.to,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    @RequirePermission('medicalRecords', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const record = await recordsService.getMedicalRecord(params.id);
        return { data: record };
    }

    @Post()
    @RequirePermission('medicalRecords')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createMedicalRecordSchema)) body: CreateInput,
        @CurrentUser() user: AuthUser,
    ) {
        const record = await recordsService.createMedicalRecord(body, toActor(user));
        return { data: record };
    }

    @Patch(':id')
    @RequirePermission('medicalRecords')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateMedicalRecordSchema)) body: UpdateInput,
        @CurrentUser() user: AuthUser,
    ) {
        const record = await recordsService.updateMedicalRecord(params.id, body, toActor(user));
        return { data: record };
    }

    /**
     * Sube el archivo (estudio, radiografía, receta escaneada) directo a la nota:
     * un solo `multipart/form-data` en campo `file`, sin pasar por `/v1/uploads`,
     * para que quede bajo `clinical/<patientId>/<recordId>/`.
     */
    @Post(':id/attachments')
    @RequirePermission('medicalRecords')
    @UseInterceptors(FileUploadInterceptor)
    @HttpCode(201)
    async addAttachment(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Req() req: Request,
        @CurrentUser() user: AuthUser,
    ) {
        if (!req.file) {
            throw badRequest('El archivo es requerido');
        }
        const record = await recordsService.addAttachment(params.id, req.file, toActor(user));
        return { data: record };
    }

    /** URL de descarga temporal; no se persiste en el documento. */
    @Get(':id/attachments/:attachmentId/url')
    @RequirePermission('medicalRecords', 'read')
    async attachmentUrl(
        @Param(new ZodValidationPipe(attachmentParamsSchema)) params: AttachmentParams,
    ) {
        const attachment = await recordsService.getAttachmentUrl(
            params.id,
            params.attachmentId,
        );
        return { data: attachment };
    }

    @Delete(':id/attachments/:attachmentId')
    @RequirePermission('medicalRecords')
    async removeAttachment(
        @Param(new ZodValidationPipe(attachmentParamsSchema)) params: AttachmentParams,
        @CurrentUser() user: AuthUser,
    ) {
        const record = await recordsService.removeAttachment(
            params.id,
            params.attachmentId,
            toActor(user),
        );
        return { data: record };
    }
}
