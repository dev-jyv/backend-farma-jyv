module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/test/**/*.spec.ts'],
    setupFiles: ['<rootDir>/test/setup-env.ts'],
    testTimeout: 20000,
};
