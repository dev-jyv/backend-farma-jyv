import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { parseFileUpload } from '../middleware/upload';
import { badRequest } from '../utils/errors';
import * as uploadsService from '../services/uploads.service';

const router = Router();

router.use(authenticate);

router.post(
    '/',
    requirePermission('uploads'),
    parseFileUpload('file'),
    async (req, res, next) => {
        try {
            if (!req.file) {
                throw badRequest('El archivo es requerido');
            }

            const result = await uploadsService.uploadFileToStorage(req.file);
            res.status(201).json({ data: result });
        } catch (error) {
            next(error);
        }
    },
);

export default router;
