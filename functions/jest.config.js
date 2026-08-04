module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/test/**/*.spec.ts'],
    setupFiles: ['<rootDir>/test/setup-env.ts'],
    setupFilesAfterEnv: ['<rootDir>/test/teardown-admin.ts'],
    testTimeout: 30000,
    // Serial: las suites comparten el emulador de Firestore y en paralelo se pelean
    // por los locks de transacción (ABORTED: Transaction lock timeout).
    maxWorkers: 1,
};
