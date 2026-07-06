import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddMetadataToOcrResult1720400000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'ocr_result',
            new TableColumn({
                name: 'metadata',
                type: 'jsonb',
                isNullable: true,
                comment: 'LLM call metadata (provider, model, tier, token usage) — same shape as chat_message.metadata. No cost/USD stored.',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('ocr_result', 'metadata');
    }
}
