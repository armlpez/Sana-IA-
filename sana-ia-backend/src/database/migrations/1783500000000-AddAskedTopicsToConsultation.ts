import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddAskedTopicsToConsultation1783500000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'consultation',
            new TableColumn({
                name: 'askedTopics',
                type: 'jsonb',
                default: "'[]'",
                isNullable: false,
                comment:
                    'Temas clínicos ya indagados (valores de CONVERSATION_TOPICS). Acumulado por código desde el topicAsked del LLM — anti-repetición determinística.',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('consultation', 'askedTopics');
    }
}
