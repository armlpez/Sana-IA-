import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddInternalErrorMessageToOcrResult1720300000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'ocr_result',
            new TableColumn({
                name: 'internalErrorMessage',
                type: 'text',
                isNullable: true,
                comment: 'Internal error message for debugging (not shown to clients). Contains detailed error from LLM provider.',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('ocr_result', 'internalErrorMessage');
    }
}
