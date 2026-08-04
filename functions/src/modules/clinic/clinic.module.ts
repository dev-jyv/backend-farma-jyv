import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { MedicalRecordsController } from './medical-records.controller';
import { PatientsController } from './patients.controller';

/** Consultorio: padrón de pacientes, expediente clínico y agenda de citas. */
@Module({
    controllers: [PatientsController, MedicalRecordsController, AppointmentsController],
})
export class ClinicModule {}
