export const getAllowedOrigins = (): string[] => {
    const raw = process.env.CORS_ORIGINS
        ?? 'http://localhost:3000,http://localhost:5173,http://localhost:4200,https://farma-jyv.web.app';

    return raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
};
