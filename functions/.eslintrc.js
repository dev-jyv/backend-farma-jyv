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
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
    },
    ignorePatterns: [
        '/lib/**/*',
        '.eslintrc.js',
    ],
    plugins: [
        '@typescript-eslint',
    ],
    rules: {
        'quotes': ['error', 'single'],
        'indent': ['error', 4],
        'max-len': ['error', { code: 100 }],
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
};
