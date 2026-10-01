import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AssistantChatInput, assistantChatSchema } from '../../schemas/assistant';
import * as assistantService from '../../services/assistant.service';
import { AuthUser } from '../../types';
import { AppError } from '../../utils/errors';
import { RateLimiter } from '../../utils/rate-limiter';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';

const chatLimiter = new RateLimiter(15, 60_000);

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
}
