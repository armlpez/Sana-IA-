import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';
import { TokenType } from '../enums/token-type.enum';

/**
 * UserToken — single-purpose, single-use tokens for email verification and
 * password reset flows.
 *
 * Leaf entity: intentionally has NO TypeORM relation to the User entity, to
 * keep TokensModule free of dependencies on Auth/Users. `userId` is a plain
 * reference column; the FK to user(id) ON DELETE CASCADE is enforced at the
 * database level via migration once this module is wired into the app's
 * TypeORM entity list (a later PR — see tasks.md Phase 3+).
 */
@Entity()
@Index(['userId', 'type'])
export class UserToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** FK -> user(id) ON DELETE CASCADE (enforced via migration, no ORM relation — see class doc). */
  @Column()
  userId: number;

  @Column({ length: 64, unique: true })
  tokenHash: string;

  @Column({ type: 'enum', enum: TokenType })
  type: TokenType;

  @Column({ length: 255, nullable: true })
  targetEmail: string | null;

  @Column()
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  consumedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
