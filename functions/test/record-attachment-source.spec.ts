import { assertRecordAttachmentSource } from '../src/services/medical-records.service';
import { AppError } from '../src/utils/errors';

const RUTA = 'uploads/abc1234567890/estudio.pdf';
const YO = 'uid-doctor';

describe('assertRecordAttachmentSource', () => {
    it('acepta un archivo subido por el mismo usuario para el expediente', () => {
        expect(() => assertRecordAttachmentSource(RUTA, {
            purpose: 'record-attachment',
            uploadedBy: YO,
        }, YO)).not.toThrow();
    });

    it('rechaza un comprobante, el expediente de otro paciente o una ruta ajena', () => {
        const ajenas = [
            'facturas/abc1234567890/factura.pdf',
            'clinical/paciente/nota/archivo.pdf',
            'uploads/../facturas/abc1234567890/factura.pdf',
            'uploads/abc/estudio.pdf',
        ];
        for (const ruta of ajenas) {
            expect(() => assertRecordAttachmentSource(ruta, {
                purpose: 'record-attachment',
                uploadedBy: YO,
            }, YO)).toThrow(AppError);
        }
    });

    it('rechaza la subida de otro usuario o un comprobante en uploads/', () => {
        expect(() => assertRecordAttachmentSource(RUTA, {
            purpose: 'record-attachment',
            uploadedBy: 'uid-cajero',
        }, YO)).toThrow(/subida de este usuario/);
        expect(() => assertRecordAttachmentSource(RUTA, {
            purpose: 'invoice',
            uploadedBy: YO,
        }, YO)).toThrow(/subida de este usuario/);
    });
});
