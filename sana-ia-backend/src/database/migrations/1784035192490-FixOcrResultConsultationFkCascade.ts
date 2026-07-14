import { MigrationInterface, QueryRunner } from "typeorm";

export class FixOcrResultConsultationFkCascade1784035192490 implements MigrationInterface {
    name = 'FixOcrResultConsultationFkCascade1784035192490'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // The original FK (CreateOcrResultTable) was created with ON DELETE NO ACTION,
        // while the entity decorator claimed SET NULL — neither matched the product
        // decision: deleting a consultation deletes its attached lab results.
        // CASCADE also unblocks DELETE /v1/ai/conversations against databases where
        // some other code path deletes a consultation without the explicit cleanup.
        await queryRunner.query(`ALTER TABLE "ocr_result" DROP CONSTRAINT "FK_6b565e50b9f2e4222200e64a342"`);
        await queryRunner.query(`ALTER TABLE "ocr_result" ADD CONSTRAINT "FK_6b565e50b9f2e4222200e64a342" FOREIGN KEY ("consultationId") REFERENCES "consultation"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ocr_result" DROP CONSTRAINT "FK_6b565e50b9f2e4222200e64a342"`);
        await queryRunner.query(`ALTER TABLE "ocr_result" ADD CONSTRAINT "FK_6b565e50b9f2e4222200e64a342" FOREIGN KEY ("consultationId") REFERENCES "consultation"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }
}
