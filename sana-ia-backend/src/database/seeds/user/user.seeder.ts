import { DataSource } from 'typeorm';
import { User } from '../../../users/entities/user.entity';
import { Role } from '../../../roles/entities/role.entity';
import { RoleEnum } from '../../../auth/enums/role.enum';
import * as bcrypt from 'bcrypt';

export class UserSeeder {
    constructor(private dataSource: DataSource) { }

    async run() {
        const userRepository = this.dataSource.getRepository(User);
        const roleRepository = this.dataSource.getRepository(Role);

        const adminRole = await roleRepository.findOneBy({ name: RoleEnum.ADMIN });
        const userRole = await roleRepository.findOneBy({ name: RoleEnum.USER });

        if (!adminRole || !userRole) {
            console.error('Roles not found. Make sure to run RoleSeeder first.');
            return;
        }

        const hashedPassword = await bcrypt.hash('12345678', 10);

        const usersData = [
            {
                email: 'admin@gmail.com',
                name: 'Admin User',
                password: hashedPassword,
                birthDate: new Date(),
                disclaimerAccepted: true,
                role: adminRole,
                isEmailVerified: true,
                emailVerifiedAt: new Date(),
            },
            {
                email: 'user@gmail.com',
                name: 'Normal User',
                password: hashedPassword,
                birthDate: new Date(),
                disclaimerAccepted: true,
                role: userRole,
                isEmailVerified: true,
                emailVerifiedAt: new Date(),
            },
        ];

        for (const userData of usersData) {
            const exists = await userRepository.findOneBy({ email: userData.email });
            if (!exists) {
                await userRepository.save(userRepository.create(userData));
                console.log(`User ${userData.email} created`);
            } else {
                console.log(`User ${userData.email} already exists`);
            }
        }
    }
}
