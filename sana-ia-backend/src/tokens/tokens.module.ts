import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserToken } from './entities/user-token.entity';
import { TokenService } from './token.service';

/**
 * Leaf module — zero dependencies on Auth/Users. Consumers inject
 * `TokenService` directly; nothing else is exported.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserToken])],
  providers: [TokenService],
  exports: [TokenService],
})
export class TokensModule {}
