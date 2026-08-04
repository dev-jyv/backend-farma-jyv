import {
    Body, Controller, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    createPatientSchema,
    idParamSchema,
    listPatientsQuerySchema,
    paginationFields,
    updatePatientSchema,
} from '../../schemas';
import * as patientsService from '../../services/patients.service';
import * as recordsService from '../../services/medical-records.service';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

const timelineQuerySchema = z.object(paginationFields);

type ListPatientsQuery = z.infer<typeof listPatientsQuerySchema>;
type TimelineQuery = z.infer<typeof timelineQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreatePatientInput = z.infer<typeof createPatientSchema>;
type UpdatePatientInput = z.infer<typeof updatePatientSchema>;

@Controller('patients')
export class PatientsController {
    @Get()
    @RequirePermission('patients', 'read')
    async list(
        @Query(new ZodValidationPipe(listPatientsQuerySchema)) query: ListPatientsQuery,
    ) {
        const result = await patientsService.listPatients({
            search: query.search,
            includeInactive: query.includeInactive === 'true',
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    @RequirePermission('patients', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const patient = await patientsService.getPatient(params.id);
        return { data: patient };
    }

    /** Encabezado del expediente: paciente + conteos de notas y citas próximas. */
    @Get(':id/overview')
    @RequirePermission('patients', 'read')
    async overview(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const overview = await patientsService.getPatientOverview(params.id);
        return { data: overview };
    }

    /**
     * Línea de tiempo clínica del paciente. Va tras `medicalRecords:read`, no
     * tras `patients:read`: recepción ve al paciente pero no sus notas.
     */
    @Get(':id/records')
    @RequirePermission('medicalRecords', 'read')
    async records(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Query(new ZodValidationPipe(timelineQuerySchema)) query: TimelineQuery,
    ) {
        const result = await recordsService.getPatientTimeline(params.id, {
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Post()
    @RequirePermission('patients')
    @HttpCode(201)
    async create(@Body(new ZodValidationPipe(createPatientSchema)) body: CreatePatientInput) {
        const patient = await patientsService.createPatient(body);
        return { data: patient };
    }

    @Patch(':id')
    @RequirePermission('patients')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updatePatientSchema)) body: UpdatePatientInput,
    ) {
        const patient = await patientsService.updatePatient(params.id, body);
        return { data: patient };
    }
}
