import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { UserToken } from './entities/user-token.entity';
import { TokenType } from './enums/token-type.enum';
import {
  invalidTokenException,
  expiredTokenException,
  consumedTokenException,
} from './token.errors';

/** Token time-to-live, keyed by type (design: PASSWORD_RESET 30min, EMAIL_VERIFICATION 24h). */
const TOKEN_TTL_MS: Record<TokenType, number> = {
  [TokenType.PASSWORD_RESET]: 30 * 60 * 1000,
  [TokenType.EMAIL_VERIFICATION]: 24 * 60 * 60 * 1000,
};

export interface ConsumedToken {
  userId: number;
  targetEmail: string | null;
}

@Injectable()
export class TokenService {
  constructor(
    @InjectRepository(UserToken)
    private readonly tokenRepo: Repository<UserToken>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Issues a new raw token for `userId`/`type`. Only the SHA-256 hash of the
   * raw token is ever persisted. Consumes (invalidates) all prior un-consumed
   * tokens of the same type for that user inside a transaction, guaranteeing
   * at most one live token per (user, type) pair.
   */
  async issue(userId: number, type: TokenType, targetEmail?: string): Promise<string> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hash(rawToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS[type]);

    await this.dataSource.transaction(async (manager) => {
      const priorTokens = await manager.find(UserToken, {
        where: { userId, type, consumedAt: IsNull() },
      });

      if (priorTokens.length > 0) {
        const now = new Date();
        await manager.save(
          UserToken,
          priorTokens.map((token) => ({ ...token, consumedAt: now })),
        );
      }

      const newToken = manager.create(UserToken, {
        userId,
        tokenHash,
        type,
        targetEmail: targetEmail ?? null,
        expiresAt,
      });
      await manager.save(UserToken, newToken);
    });

    return rawToken;
  }

  /**
   * Consumes (marks used) the token matching `rawToken`/`type` via a single
   * indexed lookup on `tokenHash`. Expired rows are lazy-deleted on encounter
   * (design D5) instead of waiting for a cleanup job.
   */
  async consume(rawToken: string, type: TokenType): Promise<ConsumedToken> {
    const tokenHash = this.hash(rawToken);
    const token = await this.tokenRepo.findOne({ where: { tokenHash } });

    if (!token || token.type !== type) {
      throw invalidTokenException(type);
    }

    if (token.expiresAt.getTime() < Date.now()) {
      await this.tokenRepo.delete({ id: token.id });
      throw expiredTokenException(type);
    }

    if (token.consumedAt) {
      throw consumedTokenException(type);
    }

    await this.tokenRepo.save({ ...token, consumedAt: new Date() });

    return { userId: token.userId, targetEmail: token.targetEmail };
  }

  private hash(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }
}
