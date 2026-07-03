import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sana_db',
    synchronize: process.env.NODE_ENV === 'development',
    logging: process.env.NODE_ENV === 'development',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    extra: {
        max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
        idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? '30000', 10),
        connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS ?? '2000', 10),
    },
}));
