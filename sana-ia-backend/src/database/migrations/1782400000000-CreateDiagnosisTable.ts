import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDiagnosisTable1782400000000 implements MigrationInterface {
    name = 'CreateDiagnosisTable1782400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."diagnosis_statusatemit_enum" AS ENUM('collecting', 'analyzing', 'completed')`);
        await queryRunner.query(`CREATE TABLE "diagnosis" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "consultationId" integer NOT NULL, "userId" integer NOT NULL, "statusAtEmit" "public"."diagnosis_statusatemit_enum" NOT NULL, "isEmergency" boolean NOT NULL DEFAULT false, "suggestedSpecialist" character varying(255), "confidenceLevel" integer, "payload" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_diagnosis_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_diagnosis_consultation_createdAt" ON "diagnosis" ("consultationId", "createdAt")`);
        await queryRunner.query(`ALTER TABLE "diagnosis" ADD CONSTRAINT "FK_diagnosis_consultation" FOREIGN KEY ("consultationId") REFERENCES "consultation"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "diagnosis" ADD CONSTRAINT "FK_diagnosis_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "diagnosis" DROP CONSTRAINT "FK_diagnosis_user"`);
        await queryRunner.query(`ALTER TABLE "diagnosis" DROP CONSTRAINT "FK_diagnosis_consultation"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_diagnosis_consultation_createdAt"`);
        await queryRunner.query(`DROP TABLE "diagnosis"`);
        await queryRunner.query(`DROP TYPE "public"."diagnosis_statusatemit_enum"`);
    }

}
