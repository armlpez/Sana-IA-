import { Injectable, UnauthorizedException, Logger, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshToken } from './entities/refresh-token.entity';
import { JwtPayload, ValidatedUser } from './interfaces';
import { LoginResponseDto } from './dto/login-response.dto';
import { User } from '../users/entities/user.entity';
import { TokenService } from '../tokens/token.service';
import { TokenType } from '../tokens/enums/token-type.enum';
import { EmailProducer } from '../email/email.producer';
import { verificationEmailTemplate } from '../email/templates/verification-email.template';
import { passwordResetEmailTemplate } from '../email/templates/password-reset-email.template';
import { AppException } from '../common/exceptions/app-exception';
import { ErrorCode } from '../common/enums/error-codes.enum';

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    // Cache config values to avoid repeated reads
    private readonly refreshSecret: string;
    private readonly refreshExpiration: string;

    constructor(
        private usersService: UsersService,
        private jwtService: JwtService,
        private configService: ConfigService,
        @InjectRepository(RefreshToken)
        private refreshTokenRepository: Repository<RefreshToken>,
        @InjectRepository(User)
        private userRepository: Repository<User>,
        private readonly tokenService: TokenService,
        private readonly emailProducer: EmailProducer,
    ) {
        this.refreshSecret = this.configService.get<string>('JWT_REFRESH_SECRET') || 'default-refresh-secret';
        this.refreshExpiration = this.configService.get<string>('JWT_REFRESH_EXPIRATION') || '7d';
    }

    // ==================== Public Methods ====================

    async validateUser(email: string, password: string): Promise<ValidatedUser | null> {
        const user = await this.usersService.findByEmail(email);

        if (!user) {
            this.logger.warn(`Login failed: User with email ${email} not found`);
            return null;
        }

        if (!user.isActive) {
            this.logger.warn(`Login failed: User ${email} is inactive`);
            return null;
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            this.logger.warn(`Login failed: Invalid password for ${email}`);
            return null;
        }

        // Email verification gate — runs ONLY after a correct password match,
        // so a wrong-password probe never reveals whether an account is
        // verified (no verification-status leak). Gated by
        // EMAIL_VERIFICATION_ENFORCED as a login-block kill-switch: everything
        // else (registration, verify/resend/reset flows) is unaffected by it.
        if (this.isEmailVerificationEnforced() && !user.isEmailVerified) {
            this.logger.warn(`Login blocked: User ${email} has not verified their email`);
            throw new AppException({
                errorCode: ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
                message: `Login blocked: user ${email} has not verified their email`,
                statusCode: HttpStatus.FORBIDDEN,
                publicMessage:
                    'Tu cuenta aún no ha sido verificada. Revisa tu correo o solicita un nuevo enlace de verificación.',
            });
        }

        const { password: _, ...result } = user;
        return result;
    }

    async validateLogin(email: string, password: string): Promise<LoginResponseDto> {
        const user = await this.validateUser(email, password);

        if (!user) {
            throw new UnauthorizedException('Credenciales inválidas');
        }

        return this.login(user);
    }

    async login(user: ValidatedUser): Promise<LoginResponseDto> {
        const payload: JwtPayload = {
            sub: user.id,
            email: user.email,
            role: user.role?.name || 'user',
        };

        const refreshToken = this.generateRefreshToken(payload);
        await this.saveRefreshToken(refreshToken, user.id);

        this.logger.log(`User ${user.email} logged in successfully`);

        return {
            access_token: this.jwtService.sign(payload),
            refresh_token: refreshToken,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role?.name || 'user',
            },
        };
    }

    async refresh(refreshToken: string): Promise<LoginResponseDto> {
        const payload = this.verifyRefreshToken(refreshToken);
        const matchingToken = await this.findAndValidateStoredToken(refreshToken, payload.sub);

        // Refresh Rotation: Revoke used token
        await this.revokeToken(matchingToken);

        // Fetch user with role and issue new tokens
        const user = await this.usersService.findOne(payload.sub);
        if (!user) {
            throw new UnauthorizedException('Usuario no encontrado');
        }

        return this.login(user as ValidatedUser);
    }

    async logout(refreshToken: string): Promise<void> {
        try {
            const payload = this.jwtService.decode(refreshToken) as JwtPayload | null;
            if (!payload?.sub) return;

            const tokens = await this.getActiveTokensForUser(payload.sub);

            for (const tokenEntity of tokens) {
                if (await bcrypt.compare(refreshToken, tokenEntity.token)) {
                    await this.revokeToken(tokenEntity);
                    break;
                }
            }
        } catch {
            // Silently ignore logout errors
        }
    }

    /**
     * Bulk-revokes ALL active (non-revoked) refresh tokens for `userId` in a
     * single UPDATE statement — not a per-token loop. Called on a successful
     * password reset so every existing session is invalidated at once.
     */
    async revokeAllForUser(userId: number): Promise<void> {
        await this.refreshTokenRepository.update(
            { user: { id: userId } as Partial<User>, isRevoked: false },
            { isRevoked: true },
        );
    }

    /**
     * Anti-enumeration: ALWAYS resolves successfully, regardless of whether
     * `email` belongs to a registered account. If the user exists, issues a
     * PASSWORD_RESET token (TokenService consumes any prior un-consumed
     * token of the same type) and enqueues the reset email. Never throws —
     * neither a missing user nor a downstream failure should surface to the
     * caller (log-and-continue, mirrors UsersService's verification-email
     * pattern from PR3).
     */
    async forgotPassword(email: string): Promise<void> {
        try {
            const user = await this.usersService.findByEmail(email);
            if (!user) return;

            const rawToken = await this.tokenService.issue(user.id, TokenType.PASSWORD_RESET);
            const frontendUrl = this.configService.get<string>('FRONTEND_URL');
            const emailContent = passwordResetEmailTemplate(frontendUrl as string, rawToken);

            await this.emailProducer.enqueue({
                to: user.email,
                ...emailContent,
            });
        } catch (error) {
            this.logger.error(`Error in forgotPassword flow for ${email}`, (error as Error).stack);
        }
    }

    /**
     * Consumes a PASSWORD_RESET token (invalid/expired errors — ERR_AUTH_008/
     * 009 — come free from TokenService.consume). On success: rotates the
     * bcrypt hash, revokes every active session for the user, and — since
     * the reset link proves ownership of the registered email — marks the
     * account verified if it wasn't already.
     */
    async resetPassword(rawToken: string, newPassword: string): Promise<void> {
        const { userId } = await this.tokenService.consume(rawToken, TokenType.PASSWORD_RESET);

        const user = await this.userRepository.findOneBy({ id: userId });
        if (!user) {
            // Defensive: the token was valid but the user no longer exists.
            return;
        }

        user.password = await bcrypt.hash(newPassword, 10);

        if (!user.isEmailVerified) {
            user.isEmailVerified = true;
            user.emailVerifiedAt = new Date();
        }

        await this.userRepository.save(user);
        await this.revokeAllForUser(userId);
    }

    /**
     * Consumes an EMAIL_VERIFICATION token (invalid/expired errors —
     * ERR_AUTH_010/011 — come free from TokenService.consume). On success:
     * marks the account verified. If the token targets a pending email
     * change (`targetEmail === user.pendingEmail && targetEmail !==
     * user.email`), re-checks uniqueness and either swaps `email` <-
     * `targetEmail` (clearing `pendingEmail`) or, if another account has
     * since claimed that address, throws a USER_CONFLICT 409 and clears
     * `pendingEmail` (the token is already spent; the user must re-initiate
     * with a different address). A stale `targetEmail` (no longer matching
     * the current `pendingEmail`, e.g. the user changed it again) is
     * defensively left un-swapped — normally unreachable because issuing a
     * newer token already consumed this one via consume-prior.
     */
    async verifyEmail(rawToken: string): Promise<void> {
        const { userId, targetEmail } = await this.tokenService.consume(rawToken, TokenType.EMAIL_VERIFICATION);

        const user = await this.userRepository.findOneBy({ id: userId });
        if (!user) {
            // Defensive: the token was valid but the user no longer exists.
            return;
        }

        const isPendingEmailSwap =
            !!targetEmail && targetEmail === user.pendingEmail && targetEmail !== user.email;

        if (isPendingEmailSwap) {
            const conflictingUser = await this.userRepository.findOneBy({ email: targetEmail as string });

            if (conflictingUser && conflictingUser.id !== user.id) {
                user.pendingEmail = null as unknown as string;
                await this.userRepository.save(user);

                throw new AppException({
                    errorCode: ErrorCode.USER_CONFLICT,
                    message: `Email ${targetEmail} was claimed by another account before verification completed`,
                    statusCode: HttpStatus.CONFLICT,
                    publicMessage:
                        'Ese correo ya fue registrado por otra cuenta. Solicita el cambio nuevamente con una dirección diferente.',
                });
            }

            user.email = targetEmail as string;
            user.pendingEmail = null as unknown as string;
        }

        user.isEmailVerified = true;
        user.emailVerifiedAt = new Date();

        await this.userRepository.save(user);
    }

    /**
     * Anti-enumeration: ALWAYS resolves successfully. Only when the user
     * exists AND is unverified does it issue a new EMAIL_VERIFICATION token
     * (consuming prior un-consumed tokens of the same type) and enqueue the
     * verification email. Already-verified or nonexistent emails are silent
     * no-ops with an identical (successful) outcome.
     */
    async resendVerification(email: string): Promise<void> {
        try {
            const user = await this.usersService.findByEmail(email);
            if (!user || user.isEmailVerified) return;

            const rawToken = await this.tokenService.issue(user.id, TokenType.EMAIL_VERIFICATION, user.email);
            const frontendUrl = this.configService.get<string>('FRONTEND_URL');
            const emailContent = verificationEmailTemplate(frontendUrl as string, rawToken);

            await this.emailProducer.enqueue({
                to: user.email,
                ...emailContent,
            });
        } catch (error) {
            this.logger.error(`Error in resendVerification flow for ${email}`, (error as Error).stack);
        }
    }

    // ==================== Private Helper Methods ====================

    /** Default (env var unset) = enforced. Only the literal string 'false' disables the login gate. */
    private isEmailVerificationEnforced(): boolean {
        const raw = this.configService.get<string>('EMAIL_VERIFICATION_ENFORCED');
        return (raw ?? 'true') !== 'false';
    }

    private generateRefreshToken(payload: JwtPayload): string {
        return this.jwtService.sign(payload, {
            secret: this.refreshSecret,
            expiresIn: this.refreshExpiration,
        } as Parameters<typeof this.jwtService.sign>[1]);
    }

    private async saveRefreshToken(token: string, userId: number): Promise<void> {
        const hashedToken = await bcrypt.hash(token, 10);
        const expiresAt = this.parseExpirationToDate(this.refreshExpiration);

        await this.refreshTokenRepository.save({
            token: hashedToken,
            user: { id: userId } as Partial<User>,
            expiresAt,
        });
    }

    private verifyRefreshToken(token: string): JwtPayload {
        try {
            return this.jwtService.verify(token, { secret: this.refreshSecret });
        } catch {
            throw new UnauthorizedException('Token de refresco inválido');
        }
    }

    private async findAndValidateStoredToken(refreshToken: string, userId: number): Promise<RefreshToken> {
        const tokens = await this.getActiveTokensForUser(userId);

        for (const tokenEntity of tokens) {
            const isMatch = await bcrypt.compare(refreshToken, tokenEntity.token);
            if (isMatch) {
                if (tokenEntity.expiresAt < new Date()) {
                    throw new UnauthorizedException('Token de refresco expirado');
                }
                return tokenEntity;
            }
        }

        // No matching token found - potential reuse attack
        throw new UnauthorizedException('Token de refresco inválido o revocado');
    }

    private async getActiveTokensForUser(userId: number): Promise<RefreshToken[]> {
        return this.refreshTokenRepository.find({
            where: { user: { id: userId }, isRevoked: false },
        });
    }

    private async revokeToken(token: RefreshToken): Promise<void> {
        token.isRevoked = true;
        await this.refreshTokenRepository.save(token);
    }

    private parseExpirationToDate(expiration: string): Date {
        const date = new Date();

        if (expiration.endsWith('d')) {
            const days = parseInt(expiration.replace('d', ''), 10);
            date.setDate(date.getDate() + days);
        } else if (expiration.endsWith('h')) {
            const hours = parseInt(expiration.replace('h', ''), 10);
            date.setHours(date.getHours() + hours);
        } else if (expiration.endsWith('m')) {
            const minutes = parseInt(expiration.replace('m', ''), 10);
            date.setMinutes(date.getMinutes() + minutes);
        } else if (expiration.endsWith('s')) {
            const seconds = parseInt(expiration.replace('s', ''), 10);
            date.setSeconds(date.getSeconds() + seconds);
        }

        return date;
    }
}
