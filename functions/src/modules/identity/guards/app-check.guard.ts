import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import * as logger from 'firebase-functions/logger';
import { getAppCheckMode } from '../../../config/env';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export const APP_CHECK_HEADER = 'x-firebase-appcheck';

/**
 * Tope para la verificación. `verifyToken` valida la firma en local con las
 * llaves públicas de App Check, que el SDK descarga una vez y cachea; si esa
 * descarga se cuelga, la petición no debe esperar al timeout del SDK. Pasado el
 * tope se registra `invalid` y la petición sigue.
 */
export const APP_CHECK_VERIFY_TIMEOUT_MS = 2000;

export type AppCheckOutcome = 'valid' | 'missing' | 'invalid';

/**
 * Clasificación gruesa del cliente por `User-Agent`, para que la consulta de
 * Logging separe la caja (que no manda App Check y sale siempre `missing`) del
 * panel. Es un dato de medición, **no** de autorización: el `User-Agent` lo
 * escribe el cliente y se falsifica con una línea.
 */
export const classifyClient = (userAgent: string | undefined): string => {
    if (!userAgent) {
        return 'sin-user-agent';
    }
    if (/Electron\//i.test(userAgent)) {
        return 'pos';
    }
    if (/Mozilla\//i.test(userAgent)) {
        return 'navegador';
    }
    return 'script';
};

/**
 * `firebase-admin/app-check` se carga en la primera petición que trae la
 * cabecera, no al arrancar: `app.module` está en el camino frío de `api` y las
 * peticiones de la caja nunca la mandan.
 */
const verifyAppCheckToken = async (token: string): Promise<unknown> => {
    const { getAppCheck } = await import('firebase-admin/app-check');
    return getAppCheck().verifyToken(token);
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Verificación de App Check excedió ${ms} ms`)),
            ms,
        );
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });

/**
 * App Check en **modo registro** (SPEC 41). Corre antes de `AuthGuard` y nunca
 * rechaza: verifica `X-Firebase-AppCheck` si viene y, cuando falta o no es
 * válida, deja un log estructurado para medir quién llama a la API sin pasar
 * por el panel. Decidir si se rechaza (`enforce`) es otro spec, con estos datos.
 *
 * El log se escribe al cerrar la respuesta y no aquí: el guard corre antes que
 * `AuthGuard`, así que el `uid` todavía no existe. Leerlo del token sin verificar
 * dejaría que cualquiera escribiera el uid que quisiera en el log.
 *
 * Las rutas `@Public()` (`/health`, webhook de Mercado Pago, `/internal/*`) se
 * saltan: no tienen cliente de navegador y solo meterían ruido en la medición.
 */
@Injectable()
export class AppCheckGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (getAppCheckMode() === 'off') {
            return true;
        }

        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) {
            return true;
        }

        const http = context.switchToHttp();
        const req = http.getRequest<Request>();
        const res = http.getResponse<Response>();

        const outcome = await this.check(req);
        if (outcome.result !== 'valid') {
            this.logOnFinish(req, res, outcome.result, outcome.reason);
        }
        return true;
    }

    private async check(
        req: Request,
    ): Promise<{ result: AppCheckOutcome; reason?: string }> {
        const raw = req.headers[APP_CHECK_HEADER];
        const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();
        if (!token) {
            return { result: 'missing' };
        }

        try {
            await withTimeout(verifyAppCheckToken(token), APP_CHECK_VERIFY_TIMEOUT_MS);
            return { result: 'valid' };
        } catch (error) {
            // Token vencido, firma inválida, otro proyecto o el servicio caído:
            // todo cuenta como `invalid` y la petición pasa igual.
            const reason = error instanceof Error ? error.message : String(error);
            return { result: 'invalid', reason: reason.slice(0, 200) };
        }
    }

    private logOnFinish(
        req: Request,
        res: Response,
        result: Exclude<AppCheckOutcome, 'valid'>,
        reason?: string,
    ): void {
        const write = (): void => {
            const userAgent = req.headers['user-agent'];
            logger.warn('Petición sin App Check válido', {
                appCheck: result,
                path: req.path,
                method: req.method,
                uid: req.authUser?.uid ?? null,
                userAgent: userAgent ?? null,
                client: classifyClient(userAgent),
                origin: req.headers.origin ?? null,
                status: res.statusCode,
                ...(reason ? { reason } : {}),
            });
        };

        // `close` y no `finish`: también se emite si el cliente corta la conexión.
        if (typeof res?.once === 'function') {
            res.once('close', write);
            return;
        }
        write();
    }
}
