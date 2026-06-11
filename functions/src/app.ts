import express from 'express';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import routes from './routes';

export const createApp = (): express.Application => {
    const app = express();

    app.use(corsMiddleware);
    app.use(express.json());
    app.use('/v1', routes);
    app.use(errorHandler);

    return app;
};
