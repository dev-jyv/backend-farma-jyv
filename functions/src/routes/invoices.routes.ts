import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    createInvoiceSchema,
    idParamSchema,
    listInvoicesQuerySchema,
} from '../schemas';
import * as invoicesService from '../services/invoices.service';

const router = Router();

router.use(authenticate);
router.use(requirePermission('invoices'));

router.get(
    '/',
    validate({ query: listInvoicesQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await invoicesService.listInvoices({
                supplierId: req.query.supplierId as string | undefined,
                from: req.query.from as string | undefined,
                to: req.query.to as string | undefined,
                hasInvoice: req.query.hasInvoice === 'true'
                    ? true
                    : req.query.hasInvoice === 'false'
                        ? false
                        : undefined,
                search: req.query.search as string | undefined,
                page: req.query.page ? Number(req.query.page) : undefined,
                limit: req.query.limit ? Number(req.query.limit) : undefined,
            });
            res.json({ data: result.items, meta: result.meta });
        } catch (error) {
            next(error);
        }
    },
);

router.get(
    '/:id',
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const invoice = await invoicesService.getInvoice(String(req.params.id));
            res.json({ data: invoice });
        } catch (error) {
            next(error);
        }
    },
);

router.post(
    '/',
    validate({ body: createInvoiceSchema }),
    async (req, res, next) => {
        try {
            const invoice = await invoicesService.createInvoice({
                supplierId: req.body.supplierId,
                invoiceNumber: req.body.invoiceNumber,
                invoiceDate: req.body.invoiceDate,
                totalAmount: req.body.totalAmount,
                hasInvoice: req.body.hasInvoice,
                fileUrl: req.body.fileUrl,
                userId: req.authUser!.uid,
            });
            res.status(201).json({ data: invoice });
        } catch (error) {
            next(error);
        }
    },
);

export default router;
