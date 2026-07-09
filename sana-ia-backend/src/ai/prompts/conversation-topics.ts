/**
 * Conjunto cerrado de temas indagables en una consulta SANA.
 * El LLM reporta la CLAVE en `topicAsked`; el código acumula el VALOR en
 * `consultation.askedTopics` (ver docs/IMPLEMENTACION-ANTI-REPETICION-CONSULTA.md).
 *
 * Todos los temas están referenciados por el system prompt actual (decisión D13):
 * - SINTOMAS / DURACION / AUTOMEDICACION → FASE 1-2 + los 3 campos de extractedData
 *   (son los mínimos de cierre de FASE 2)
 * - ANTECEDENTES → FASE 0 (datos base que pueden faltar)
 * - LABORATORIOS → FASE 2 (evidencia; también se marca cubierto vía OCR, decisión D14)
 *
 * Es el conjunto de temas POSIBLES bajo la latitud de "preguntas quirúrgicas" del
 * prompt — NO una lista de preguntas obligatorias. Comparación por clave exacta,
 * nunca matching semántico.
 */
export const CONVERSATION_TOPICS = {
    SINTOMAS: 'síntomas',
    DURACION: 'duración',
    AUTOMEDICACION: 'automedicación',
    ANTECEDENTES: 'antecedentes/patologías crónicas',
    LABORATORIOS: 'laboratorios/estudios',
} as const;

export type ConversationTopicKey = keyof typeof CONVERSATION_TOPICS;

/** Type guard: valida que el `topicAsked` reportado por el LLM sea una clave del enum. */
export function isConversationTopicKey(value: unknown): value is ConversationTopicKey {
    return typeof value === 'string' && value in CONVERSATION_TOPICS;
}
