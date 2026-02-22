import { Role } from "../../roles/entities/role.entity";
import { RefreshToken } from "../../auth/entities/refresh-token.entity";
import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity()
export class User {

    @PrimaryGeneratedColumn('increment')
    id: number;

    @ManyToOne(() => Role, (role) => role.users)
    role: Role;

    @Column({ unique: true })
    email: string;

    @Column({ length: 100 })
    name: string;

    @Column({ length: 255 })
    password: string;

    @Column({ nullable: true })
    birthDate: Date;

    @Column({ default: true })
    isActive: boolean;

    @Column()
    disclaimerAccepted: boolean;

    @Column({ nullable: true })
    disclaimerAcceptedAt: Date;

    @CreateDateColumn({ type: 'timestamp' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamp', nullable: true })
    updatedAt: Date;

    @OneToMany(() => RefreshToken, (refreshToken) => refreshToken.user)
    refreshTokens: RefreshToken[];
}
