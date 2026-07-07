import { Controller, Post, Body, Get, Patch, UseGuards, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { RoleEnum } from './enums/role.enum';
import { UsersService } from '../users/users.service';
import { UpdateUserDto } from '../users/dto/update-user.dto';

import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

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
}
