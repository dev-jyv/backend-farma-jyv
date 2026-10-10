module.exports = {
    root: true,
    env: {
        es6: true,
        node: true,
    },
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
    ],
    parser: '@typescript-eslint/parser',
    parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: __dirname,
    },
    ignorePatterns: [
        '/lib/**/*',
        // Artefactos generados: no son fuente y no están en el tsconfig del lint,
        // así que el parser con `parserOptions.project` truena al tocarlos.
        '/coverage/**/*',
        '/graphify-out/**/*',
        '.eslintrc.js',
        'jest.config.js',
        'jest.rules.config.js',
    ],
    plugins: [
        '@typescript-eslint',
    ],
    rules: {
        'quotes': ['error', 'single'],
        'indent': ['error', 4],
        'max-len': ['error', { code: 100 }],
        '@typescript-eslint/no-unused-vars': [
            'error',
            { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
    },
};
