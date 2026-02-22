import { DataSource } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Role } from '../../roles/entities/role.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import * as dotenv from 'dotenv';
import { RoleSeeder } from './role/role.seeder';
import { UserSeeder } from './user/user.seeder';

dotenv.config();

const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'sana_db',
    entities: [User, Role, RefreshToken],
    synchronize: false,
});

async function runSeeds() {
    try {
        await dataSource.initialize();
        console.log('Database connected for seeding');

        // Run Role Seeder
        const roleSeeder = new RoleSeeder(dataSource);
        await roleSeeder.run();

        // Run User Seeder
        const userSeeder = new UserSeeder(dataSource);
        await userSeeder.run();

        console.log('Seeding completed successfully');
    } catch (error) {
        console.error('Error during seeding:', error);
    } finally {
        await dataSource.destroy();
    }
}

runSeeds();
