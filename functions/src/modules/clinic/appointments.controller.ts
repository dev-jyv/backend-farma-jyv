import {
    Body, Controller, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    appointmentsCalendarQuerySchema,
    availabilityQuerySchema,
    createAppointmentSchema,
    idParamSchema,
    listAppointmentsQuerySchema,
    rescheduleAppointmentSchema,
    updateAppointmentSchema,
    updateAppointmentStatusSchema,
} from '../../schemas';
import * as appointmentsService from '../../services/appointments.service';
import { AuthUser, ClinicActor } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListQuery = z.infer<typeof listAppointmentsQuerySchema>;
type CalendarQuery = z.infer<typeof appointmentsCalendarQuerySchema>;
type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateInput = z.infer<typeof createAppointmentSchema>;
type RescheduleInput = z.infer<typeof rescheduleAppointmentSchema>;
type StatusInput = z.infer<typeof updateAppointmentStatusSchema>;
type UpdateInput = z.infer<typeof updateAppointmentSchema>;

const toActor = (user: AuthUser): ClinicActor => ({
    userId: user.uid,
    displayName: user.displayName,
    roleSlug: user.role.slug,
});

@Controller('appointments')
export class AppointmentsController {
    @Get()
    @RequirePermission('appointments', 'read')
    async list(@Query(new ZodValidationPipe(listAppointmentsQuerySchema)) query: ListQuery) {
        const result = await appointmentsService.listAppointments({
            patientId: query.patientId,
            doctorId: query.doctorId,
            status: query.status,
            from: query.from,
            to: query.to,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /**
     * Lo que consume el calendario del front: rango completo sin paginar, topado
     * a 92 días para que un mes mal pedido no barra la agenda entera.
     * Declarada antes de `:id` a propósito — Nest resuelve por orden.
     */
    @Get('calendar')
    @RequirePermission('appointments', 'read')
    async calendar(
        @Query(new ZodValidationPipe(appointmentsCalendarQuerySchema)) query: CalendarQuery,
    ) {
        const appointments = await appointmentsService.getCalendar({
            from: query.from,
            to: query.to,
            doctorId: query.doctorId,
        });
        return { data: appointments };
    }

    /**
     * Horario de atención y parámetros de la agenda. El calendario del front los
     * lee de aquí en vez de repetirlos: dos copias de la misma regla se separan
     * en cuanto una cambia. También va antes de `:id`.
     */
    @Get('settings')
    @RequirePermission('appointments', 'read')
    settings() {
        return { data: appointmentsService.getClinicSettings() };
    }

    /** Doctores activos, para el selector de la agenda (no requiere `users:read`). */
    @Get('doctors')
    @RequirePermission('appointments', 'read')
    async doctors() {
        const doctors = await appointmentsService.listDoctors();
        return { data: doctors };
    }

    /** Huecos libres del día para agendar sin adivinar. */
    @Get('availability')
    @RequirePermission('appointments', 'read')
    async availability(
        @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
        @CurrentUser() user: AuthUser,
    ) {
        const availability = await appointmentsService.getAvailability({
            date: query.date,
            doctorId: query.doctorId ?? user.uid,
            durationMinutes: query.durationMinutes
                ? Number(query.durationMinutes)
                : undefined,
        });
        return { data: availability };
    }

    @Get(':id')
    @RequirePermission('appointments', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const appointment = await appointmentsService.getAppointment(params.id);
        return { data: appointment };
    }

    @Post()
    @RequirePermission('appointments')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createAppointmentSchema)) body: CreateInput,
        @CurrentUser() user: AuthUser,
    ) {
        const appointment = await appointmentsService.createAppointment(body, toActor(user));
        return { data: appointment };
    }

    @Patch(':id')
    @RequirePermission('appointments')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateAppointmentSchema)) body: UpdateInput,
    ) {
        const appointment = await appointmentsService.updateAppointment(params.id, body);
        return { data: appointment };
    }

    @Post(':id/reschedule')
    @RequirePermission('appointments')
    async reschedule(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(rescheduleAppointmentSchema)) body: RescheduleInput,
        @CurrentUser() user: AuthUser,
    ) {
        const appointment = await appointmentsService.rescheduleAppointment(
            params.id,
            body,
            toActor(user),
        );
        return { data: appointment };
    }

    /** Confirmar, iniciar, cerrar, cancelar o marcar no-show. */
    @Post(':id/status')
    @RequirePermission('appointments')
    async changeStatus(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateAppointmentStatusSchema)) body: StatusInput,
        @CurrentUser() user: AuthUser,
    ) {
        const appointment = await appointmentsService.changeAppointmentStatus(
            params.id,
            body,
            toActor(user),
        );
        return { data: appointment };
    }
}
