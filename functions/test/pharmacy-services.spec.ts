import * as servicesRepo from '../src/repositories/pharmacy-services.repository';
import * as providersRepo from '../src/repositories/service-providers.repository';
import * as pharmacyServicesService from '../src/services/pharmacy-services.service';
import * as serviceProvidersService from '../src/services/service-providers.service';

/**
 * Catálogo de servicios y padrón de doctores contra el emulador.
 *
 * Dos contratos se fijan aquí:
 *
 * 1. La baja es **lógica**. Un servicio ya cobrado sigue referenciado por las
 *    partidas de la venta; borrarlo dejaría el corte sin a qué apuntar.
 * 2. El `sync` es el que consume el POS local-first: trae **inactivos**
 *    (el catálogo local necesita reflejar bajas) y, con `updatedSince`, solo lo
 *    modificado después del cursor.
 *
 * El emulador conserva lo que dejan las demás suites, así que todo se filtra por
 * una clave/nombre propios de cada corrida.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const ACTOR = { userId: 'test-admin' };

const nuevoServicio = (overrides: Record<string, unknown> = {}) =>
    pharmacyServicesService.createPharmacyService({
        code: unique('SRV'),
        name: unique('Consulta'),
        serviceType: 'consultation',
        price: 250,
        taxMode: 'exempt',
        hasIeps: false,
        commissionRate: 40,
        requiresPerformer: true,
        ...overrides,
    } as Parameters<typeof pharmacyServicesService.createPharmacyService>[0], ACTOR);

describe('pharmacyServices - alta', () => {
    it('nace activo, con autoría y timestamps sellados', async () => {
        const creado = await nuevoServicio({ description: '  Primera vez  ' });

        expect(creado.id).toBeTruthy();
        expect(creado.isActive).toBe(true);
        expect(creado.createdBy).toBe(ACTOR.userId);
        expect(creado.updatedBy).toBe(ACTOR.userId);
        expect(creado.createdAt).toBeDefined();
        expect(creado.updatedAt).toBeDefined();
        // La descripción se guarda recortada, como en el resto del catálogo.
        expect(creado.description).toBe('Primera vez');
    });

    it('no guarda campos de inventario: un servicio no tiene stock ni costo', async () => {
        const creado = await nuevoServicio();
        const leido = (await servicesRepo.getPharmacyServiceById(creado.id)) as unknown as
            Record<string, unknown>;

        for (const campo of ['stock', 'totalStock', 'minStock', 'controlledGroup',
            'costPrice', 'batches']) {
            expect(leido).not.toHaveProperty(campo);
        }
    });

    it('rechaza una clave repetida', async () => {
        const code = unique('SRV');
        await nuevoServicio({ code });
        await expect(nuevoServicio({ code })).rejects.toThrow(/clave/i);
    });

    it('rechaza precio cero desde el servicio, no solo desde el schema', async () => {
        await expect(nuevoServicio({ price: 0 })).rejects.toThrow(/precio/i);
    });
});

describe('pharmacyServices - edición y baja lógica', () => {
    it('edita precio y comisión sin tocar la autoría de alta', async () => {
        const creado = await nuevoServicio();

        const editado = await pharmacyServicesService.updatePharmacyService(
            creado.id,
            { price: 300, commissionRate: 55 },
            { userId: 'otro-admin' },
        );

        expect(editado.price).toBe(300);
        expect(editado.commissionRate).toBe(55);
        expect(editado.createdBy).toBe(ACTOR.userId);
        expect(editado.updatedBy).toBe('otro-admin');
    });

    it('la baja apaga isActive en vez de borrar el documento', async () => {
        const creado = await nuevoServicio();

        const dado_de_baja = await pharmacyServicesService.deletePharmacyService(
            creado.id,
            ACTOR,
        );

        expect(dado_de_baja.isActive).toBe(false);
        // El documento sigue existiendo: las ventas viejas lo referencian.
        expect(await servicesRepo.getPharmacyServiceById(creado.id)).not.toBeNull();
    });

    it('404 al editar o dar de baja un servicio inexistente', async () => {
        await expect(
            pharmacyServicesService.updatePharmacyService('no-existe', { price: 10 }, ACTOR),
        ).rejects.toThrow(/no encontrado/i);
        await expect(
            pharmacyServicesService.deletePharmacyService('no-existe', ACTOR),
        ).rejects.toThrow(/no encontrado/i);
    });
});

describe('pharmacyServices - listado', () => {
    it('oculta los inactivos salvo que se pidan', async () => {
        const creado = await nuevoServicio();
        await pharmacyServicesService.deletePharmacyService(creado.id, ACTOR);

        const activos = await pharmacyServicesService.listPharmacyServices({
            activeOnly: true,
            search: creado.code,
        });
        const todos = await pharmacyServicesService.listPharmacyServices({
            activeOnly: false,
            search: creado.code,
        });

        expect(activos.items.some((item) => item.id === creado.id)).toBe(false);
        expect(todos.items.some((item) => item.id === creado.id)).toBe(true);
    });

    it('filtra por naturaleza del servicio', async () => {
        const consulta = await nuevoServicio({ serviceType: 'consultation' });
        const procedimiento = await nuevoServicio({ serviceType: 'procedure' });

        const { items } = await pharmacyServicesService.listPharmacyServices({
            activeOnly: true,
            serviceType: 'procedure',
            limit: 100,
        });
        const ids = items.map((item) => item.id);

        expect(ids).toContain(procedimiento.id);
        expect(ids).not.toContain(consulta.id);
    });

    it('busca por clave y por nombre', async () => {
        const creado = await nuevoServicio();

        const porClave = await pharmacyServicesService.listPharmacyServices({
            activeOnly: true,
            search: creado.code.toLowerCase(),
        });
        const porNombre = await pharmacyServicesService.listPharmacyServices({
            activeOnly: true,
            search: creado.name,
        });

        expect(porClave.items.map((item) => item.id)).toEqual([creado.id]);
        expect(porNombre.items.map((item) => item.id)).toEqual([creado.id]);
        expect(porClave.meta.total).toBe(1);
    });
});

describe('listPharmacyServicesForSync', () => {
    const CAMPOS_ESPERADOS = [
        'id',
        'code',
        'name',
        'description',
        'serviceType',
        'price',
        'taxMode',
        'hasIeps',
        'iepsRate',
        'commissionRate',
        'requiresPerformer',
        'isActive',
        'updatedAt',
    ];

    it('devuelve solo los campos que el POS necesita para cobrar sin red', async () => {
        const creado = await nuevoServicio();

        const { items } = await pharmacyServicesService.listPharmacyServicesForSync({});
        const sincronizado = items.find((item) => item.id === creado.id);

        expect(sincronizado).toBeDefined();
        expect(Object.keys(sincronizado!).every((key) => CAMPOS_ESPERADOS.includes(key)))
            .toBe(true);
        // La autoría es de auditoría del panel; en el mostrador nadie la lee.
        const plano = sincronizado as unknown as Record<string, unknown>;
        expect(plano).not.toHaveProperty('createdBy');
        expect(plano).not.toHaveProperty('updatedBy');
        expect(plano).not.toHaveProperty('createdAt');
    });

    it('incluye los dados de baja: el catálogo local debe reflejar bajas', async () => {
        const creado = await nuevoServicio();
        await pharmacyServicesService.deletePharmacyService(creado.id, ACTOR);

        const { items } = await pharmacyServicesService.listPharmacyServicesForSync({});
        const sincronizado = items.find((item) => item.id === creado.id);

        expect(sincronizado).toBeDefined();
        expect(sincronizado!.isActive).toBe(false);
    });

    it('el pull incremental solo trae lo modificado después del cursor', async () => {
        const creado = await nuevoServicio();
        const cursor = new Date(Date.now() + 1000).toISOString();

        const { items } = await pharmacyServicesService.listPharmacyServicesForSync({
            updatedSince: cursor,
        });

        expect(items.some((item) => item.id === creado.id)).toBe(false);
    });

    it('una edición vuelve a entrar en el pull incremental', async () => {
        const creado = await nuevoServicio();
        const cursor = new Date(Date.now() - 1).toISOString();
        await pharmacyServicesService.updatePharmacyService(creado.id, { price: 400 }, ACTOR);

        const { items } = await pharmacyServicesService.listPharmacyServicesForSync({
            updatedSince: cursor,
        });
        const sincronizado = items.find((item) => item.id === creado.id);

        expect(sincronizado?.price).toBe(400);
    });
});

describe('serviceProviders', () => {
    const nuevoDoctor = (overrides: Record<string, unknown> = {}) =>
        serviceProvidersService.createServiceProvider({
            name: unique('Dra. Ana'),
            ...overrides,
        } as Parameters<typeof serviceProvidersService.createServiceProvider>[0]);

    it('nace activo y no guarda nada de identidad: no es usuario del sistema', async () => {
        const creado = await nuevoDoctor({ license: '1234567' });
        const leido = (await providersRepo.getServiceProviderById(creado.id)) as unknown as
            Record<string, unknown>;

        expect(creado.isActive).toBe(true);
        expect(creado.license).toBe('1234567');
        for (const campo of ['uid', 'email', 'roleId', 'roleSlug', 'permissions']) {
            expect(leido).not.toHaveProperty(campo);
        }
    });

    it('edita y da de baja lógicamente', async () => {
        const creado = await nuevoDoctor();

        const editado = await serviceProvidersService.updateServiceProvider(creado.id, {
            defaultCommissionRate: 25,
        });
        expect(editado.defaultCommissionRate).toBe(25);

        const baja = await serviceProvidersService.deleteServiceProvider(creado.id);
        expect(baja.isActive).toBe(false);
        expect(await providersRepo.getServiceProviderById(creado.id)).not.toBeNull();
    });

    it('404 en doctor inexistente', async () => {
        await expect(serviceProvidersService.getServiceProvider('no-existe'))
            .rejects.toThrow(/no encontrado/i);
        await expect(serviceProvidersService.deleteServiceProvider('no-existe'))
            .rejects.toThrow(/no encontrado/i);
    });

    it('el listado oculta a los inactivos salvo que se pidan', async () => {
        const creado = await nuevoDoctor();
        await serviceProvidersService.deleteServiceProvider(creado.id);

        const activos = await serviceProvidersService.listServiceProviders({
            activeOnly: true,
            search: creado.name,
        });
        const todos = await serviceProvidersService.listServiceProviders({
            activeOnly: false,
            search: creado.name,
        });

        expect(activos.items.some((item) => item.id === creado.id)).toBe(false);
        expect(todos.items.some((item) => item.id === creado.id)).toBe(true);
    });

    it('el sync trae bajas y respeta el cursor incremental', async () => {
        const creado = await nuevoDoctor();
        await serviceProvidersService.deleteServiceProvider(creado.id);

        const completo = await serviceProvidersService.listServiceProvidersForSync({});
        expect(completo.items.find((item) => item.id === creado.id)?.isActive).toBe(false);

        const cursor = new Date(Date.now() + 1000).toISOString();
        const incremental = await serviceProvidersService.listServiceProvidersForSync({
            updatedSince: cursor,
        });
        expect(incremental.items.some((item) => item.id === creado.id)).toBe(false);
    });
});
