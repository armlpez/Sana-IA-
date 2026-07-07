import { MigrationInterface, QueryRunner } from "typeorm";

export class AddVerificationAndUserToken1783451957846 implements MigrationInterface {
    name = 'AddVerificationAndUserToken1783451957846'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // user_token: single-use, SHA-256-hashed tokens for email verification
        // and password reset (see UserToken entity in src/tokens/entities).
        await queryRunner.query(`CREATE TYPE "public"."user_token_type_enum" AS ENUM('EMAIL_VERIFICATION', 'PASSWORD_RESET')`);
        await queryRunner.query(`CREATE TABLE "user_token" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" integer NOT NULL, "tokenHash" character varying(64) NOT NULL, "type" "public"."user_token_type_enum" NOT NULL, "targetEmail" character varying(255), "expiresAt" TIMESTAMP NOT NULL, "consumedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_user_token_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_user_token_hash" ON "user_token" ("tokenHash")`);
        await queryRunner.query(`CREATE INDEX "IDX_user_token_user_type" ON "user_token" ("userId", "type")`);
        await queryRunner.query(`ALTER TABLE "user_token" ADD CONSTRAINT "FK_user_token_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        // user: email-ownership verification state (account-verification-password-reset proposal).
        await queryRunner.query(`ALTER TABLE "user" ADD "isEmailVerified" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "user" ADD "emailVerifiedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "user" ADD "pendingEmail" character varying(255)`);

        // Grandfather clause: every user that already exists before this
        // deploy is backfilled to isEmailVerified = true. This MUST run
        // before the login-gate (`validateUser`/`validateLogin` verification
        // check, shipped in a later PR of this chain) is enabled in
        // production — otherwise every pre-existing account would be
        // instantly locked out of login on deploy, since they never went
        // through the new verification-token flow.
        await queryRunner.query(`UPDATE "user" SET "isEmailVerified" = true`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "pendingEmail"`);
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "emailVerifiedAt"`);
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "isEmailVerified"`);

        await queryRunner.query(`ALTER TABLE "user_token" DROP CONSTRAINT "FK_user_token_user"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_user_token_user_type"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_user_token_hash"`);
        await queryRunner.query(`DROP TABLE "user_token"`);
        await queryRunner.query(`DROP TYPE "public"."user_token_type_enum"`);
    }

}
