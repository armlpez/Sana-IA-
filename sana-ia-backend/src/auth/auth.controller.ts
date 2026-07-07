import { Controller, Post, Body, Get, Patch, UseGuards, Request, Query, Header, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { RoleEnum } from './enums/role.enum';
import { UsersService } from '../users/users.service';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { verifyEmailPage } from './pages/verify-email.page';
import { resetPasswordPage } from './pages/reset-password.page';

import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

/**
 * Production limits for security-sensitive auth endpoints (forgot-password,
 * resend-verification, reset-password, verify-email + their HTML landing
 * pages): 15 min window, 5 req/IP. Matches the `auth-sensitive` tier
 * registered in `app.module.ts`'s `ThrottlerModule.forRoot`.
 */
const AUTH_SENSITIVE_THROTTLE = { 'auth-sensitive': { ttl: 900_000, limit: 5 } };

@Controller({ path: 'auth', version: '1' })
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly usersService: UsersService,
    ) { }

    @Post('login')
    async login(@Body() loginDto: LoginDto) {
        return this.authService.validateLogin(loginDto.email, loginDto.password);
    }

    @UseGuards(JwtRefreshGuard)
    @Post('refresh')
    refresh(@Request() req) {
        return this.authService.refresh(req.user); // req.user is just payload here usually, our Strategy returns simple object
        // Actually JwtRefreshStrategy returns payload with sub, email, role. But refresh method expects refreshToken string from body?
        // Wait, the guard validates, but the service method 'refresh(refreshToken: string)' expects the token string.
        // We should extract it from body or req.
        // In Strategy we use ExtractJwt.fromBodyField('refreshToken').
        // So req.body.refreshToken should have it.
        return this.authService.refresh(req.body.refreshToken);
    }

    @UseGuards(JwtAuthGuard)
    @Post('logout')
    async logout(@Body() body: { refreshToken: string }) {
        return this.authService.logout(body.refreshToken);
    }

    @UseGuards(JwtAuthGuard)
    @Get('profile')
    getProfile(@Request() req) {
        return req.user;
    }

    @UseGuards(JwtAuthGuard)
    @Patch('profile')
    async updateProfile(@Request() req, @Body() updateUserDto: UpdateUserDto) {
        const { email, ...otherFields } = updateUserDto;

        // Changing the email never overwrites it directly — it goes through
        // requestEmailChange (pendingEmail + verification link) so the user
        // is never logged out / locked out of their current session.
        if (email && email !== req.user.email) {
            let updatedUser: unknown;

            if (Object.keys(otherFields).length > 0) {
                updatedUser = await this.usersService.update(req.user.id, otherFields as UpdateUserDto);
            }

            const { message } = await this.usersService.requestEmailChange(req.user.id, email);

            return {
                ...(typeof updatedUser === 'object' && updatedUser !== null ? updatedUser : {}),
                message,
            };
        }

        return this.usersService.update(req.user.id, updateUserDto);
    }

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(RoleEnum.ADMIN)
    @Get('admin-only')
    adminOnly(@Request() req) {
        return {
            message: 'Este endpoint es solo para administradores',
            user: req.user,
        };
    }

    // ==================== Account Verification & Password Reset ====================
    // Public endpoints (no auth guard). forgot-password and resend-verification
    // ALWAYS return the same generic body regardless of whether the email
    // belongs to a registered account (anti-enumeration — see AuthService).

    @Throttle(AUTH_SENSITIVE_THROTTLE)
    @Post('forgot-password')
    @HttpCode(HttpStatus.OK)
    async forgotPassword(@Body() dto: ForgotPasswordDto) {
        await this.authService.forgotPassword(dto.email);
        return { message: 'Si el correo existe, enviaremos instrucciones.' };
    }

    @Throttle(AUTH_SENSITIVE_THROTTLE)
    @Post('reset-password')
    @HttpCode(HttpStatus.OK)
    async resetPassword(@Body() dto: ResetPasswordDto) {
        await this.authService.resetPassword(dto.token, dto.newPassword);
        return { message: 'Tu contraseña ha sido restablecida correctamente.' };
    }

    @Throttle(AUTH_SENSITIVE_THROTTLE)
    @Post('verify-email')
    @HttpCode(HttpStatus.OK)
    async verifyEmail(@Body() dto: VerifyEmailDto) {
        await this.authService.verifyEmail(dto.token);
        return { message: 'Tu cuenta ha sido verificada correctamente.' };
    }

    @Throttle(AUTH_SENSITIVE_THROTTLE)
    @Post('resend-verification')
    @HttpCode(HttpStatus.OK)
    async resendVerification(@Body() dto: ResendVerificationDto) {
        await this.authService.resendVerification(dto.email);
        return { message: 'Si el correo existe y requiere verificación, enviaremos un nuevo enlace.' };
    }

    // ==================== HTML Landing Pages ====================
    // The frontend is a mobile app with no web routes; email links open these
    // backend-served pages in the phone browser (see email templates).

    @Throttle(AUTH_SENSITIVE_THROTTLE)
    @Get('verify')
    @Header('Content-Type', 'text/html')
    getVerifyEmailPage(@Query('token') token: string) {
        return verifyEmailPage(token ?? '');
    }

    @Throttle(AUTH_SENSITIVE_THROTTLE)
    @Get('reset')
    @Header('Content-Type', 'text/html')
    getResetPasswordPage(@Query('token') token: string) {
        return resetPasswordPage(token ?? '');
    }
}
