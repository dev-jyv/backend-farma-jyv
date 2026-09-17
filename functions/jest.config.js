module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    // `.tsx` también: las plantillas de correo son componentes y se prueban
    // renderizándolas, no simulando su salida.
    testMatch: ['<rootDir>/test/**/*.spec.ts', '<rootDir>/test/**/*.spec.tsx'],
    setupFiles: ['<rootDir>/test/setup-env.ts'],
    setupFilesAfterEnv: ['<rootDir>/test/teardown-admin.ts'],
    testTimeout: 30000,
    // Serial: las suites comparten el emulador de Firestore y en paralelo se pelean
    // por los locks de transacción (ABORTED: Transaction lock timeout).
    maxWorkers: 1,

    collectCoverageFrom: [
        'src/**/*.ts',
        // Scripts de operación de un solo uso: se ejecutan a mano y con la vista
        // puesta en su salida, no en producción.
        '!src/scripts/**',
        '!src/**/*.d.ts',
    ],
    coverageThreshold: {
        // Piso global: no es una meta, es un trinquete. Un cambio no debería
        // poder bajar la cobertura sin que alguien lo decida a propósito
        // subiendo estos números.
        //
        // Desde que `test/teardown-admin.ts` limpia la base antes de cada
        // archivo, corridas seguidas dan el mismo número (±0.02) — antes
        // oscilaba un punto entero porque las suites compartían estado. El
        // margen que queda (~1 punto) ya no absorbe deriva del emulador sino el
        // ir y venir del código mientras se trabaja.
        global: {
            lines: 71,
            statements: 72,
            branches: 56,
            functions: 57,
        },
        // Identidad y acceso: aquí un hueco de cobertura es una escalada de
        // privilegios, así que se exige mucho más que en el resto del código.
        './src/modules/identity/guards/auth.guard.ts': {
            lines: 100,
            branches: 90,
        },
        './src/utils/memory-cache.ts': {
            lines: 100,
            branches: 90,
        },
        './src/services/users.service.ts': {
            lines: 80,
            branches: 80,
        },
    },
};
