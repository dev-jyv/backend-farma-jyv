import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
    AssistantChatInput,
    assistantChatSchema,
    SyncHelpInput,
    syncHelpSchema,
} from '../../schemas/assistant';
import * as assistantService from '../../services/assistant.service';
import * as syncHelpService from '../../services/sync-help.service';
import { AuthUser } from '../../types';
import { AppError } from '../../utils/errors';
import { RateLimiter } from '../../utils/rate-limiter';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';

const chatLimiter = new RateLimiter(15, 60_000);
const syncHelpLimiter = new RateLimiter(5, 60_000);

/**
 * Chatbot de análisis del negocio. Mismo área que los reportes (`dashboard`):
 * quien no puede ver `/v1/reports/*` tampoco puede preguntarle al asistente.
 */
@Controller('assistant')
export class AssistantController {
    @Post('chat')
    @RequirePermission('dashboard', 'read')
    @HttpCode(200)
    async chat(
        @Body(new ZodValidationPipe(assistantChatSchema)) body: AssistantChatInput,
        @CurrentUser() user: AuthUser,
    ) {
        if (!chatLimiter.tryConsume(user.uid)) {
            throw new AppError(429, 'RATE_LIMITED', 'Demasiadas solicitudes, espera un minuto');
        }
        return { data: await assistantService.chat(body.messages) };
    }

    /**
     * Ayuda con IA para un registro que el POS no pudo subir y no supo
     * diagnosticar por reglas. Es del mostrador (`pos:write`), no del panel: el
     * cajero es quien tiene el registro atorado enfrente.
     */
    @Post('sync-help')
    @RequirePermission('pos', 'write')
    @HttpCode(200)
    async syncHelp(
        @Body(new ZodValidationPipe(syncHelpSchema)) body: SyncHelpInput,
        @CurrentUser() user: AuthUser,
    ) {
        if (!syncHelpLimiter.tryConsume(user.uid)) {
            throw new AppError(429, 'RATE_LIMITED', 'Demasiadas solicitudes, espera un minuto');
        }
        return { data: await syncHelpService.syncHelp(body) };
    }
}
