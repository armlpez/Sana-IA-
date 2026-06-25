import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateOcrResultTable1782324557253 implements MigrationInterface {
    name = 'CreateOcrResultTable1782324557253'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."ocr_result_status_enum" AS ENUM('queued', 'processing', 'completed', 'failed')`);
        await queryRunner.query(`CREATE TABLE "ocr_result" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" integer NOT NULL, "consultationId" integer, "imagePath" text NOT NULL, "originalFilename" character varying(255), "status" "public"."ocr_result_status_enum" NOT NULL DEFAULT 'queued', "extractedData" jsonb, "rawText" text, "errorMessage" text, "processingTimeMs" integer, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a894d86200405fb709e73900db3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "consultation" ADD "emergencyDetected" boolean DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "ocr_result" ADD CONSTRAINT "FK_c60ee328d6c5e474e4bfde54b15" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ocr_result" ADD CONSTRAINT "FK_6b565e50b9f2e4222200e64a342" FOREIGN KEY ("consultationId") REFERENCES "consultation"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ocr_result" DROP CONSTRAINT "FK_6b565e50b9f2e4222200e64a342"`);
        await queryRunner.query(`ALTER TABLE "ocr_result" DROP CONSTRAINT "FK_c60ee328d6c5e474e4bfde54b15"`);
        await queryRunner.query(`ALTER TABLE "consultation" DROP COLUMN "emergencyDetected"`);
        await queryRunner.query(`DROP TABLE "ocr_result"`);
        await queryRunner.query(`DROP TYPE "public"."ocr_result_status_enum"`);
    }

}
