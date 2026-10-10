import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
    intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
        return next.handle().pipe(
            map((body) => {
                if (
                    body !== null &&
                    typeof body === 'object' &&
                    !Array.isArray(body) &&
                    'data' in body
                ) {
                    return body;
                }

                if (
                    body !== null &&
                    typeof body === 'object' &&
                    !Array.isArray(body) &&
                    'items' in body &&
                    'meta' in body
                ) {
                    const result = body as { items: unknown; meta: unknown };
                    return { data: result.items, meta: result.meta };
                }

                return { data: body };
            }),
        );
    }
}
