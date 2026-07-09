# Limitaciones conocidas — Mecanismo anti-repetición de consulta

Este documento registra limitaciones **conocidas y aceptadas** del mecanismo anti-repetición implementado (ver `IMPLEMENTACION-ANTI-REPETICION-CONSULTA.md`). No son bugs pendientes de arreglar en el corto plazo — son el techo actual de lo que el prompt-engineering puede garantizar sobre un LLM, documentado para que no se redescubra como "bug nuevo" en el futuro.

## Contexto

El mecanismo de anti-repetición (`askedTopics` acumulado en código + instrucción explícita en el prompt de "no repreguntar temas ya cubiertos") es **determinístico en el dato** (el código nunca pierde ni corrompe qué temas ya se preguntaron) pero **probabilístico en el cumplimiento** (depende de que el LLM respete la instrucción en cada generación). Esa segunda parte no se puede forzar por código — solo se puede reforzar con prompt-engineering, que tiene un techo real.

## Limitación 1 — Redundancia dentro del mismo turno ("Hallazgo A")

**Síntoma:** el paciente da varios datos juntos en un solo mensaje (ej. *"tengo dolor lumbar hace una semana, no tomé nada, y no tengo enfermedades crónicas"*), y la IA igual pregunta por uno de esos datos en su respuesta a ESE MISMO turno — pese a la instrucción explícita de revisar el mensaje del paciente antes de preguntar.

**Qué se intentó:** se agregó al prompt la instrucción de revisar el `[Mensaje del paciente]` del turno actual antes de formular la pregunta, y de extraer el dato ahí mismo si ya está presente.

**Resultado del fix:** parcial.
- ✅ La **extracción** de negativos ("no tomé nada" → `"ninguno declarado"`, nunca `null`) funciona de forma consistente — confirmado en múltiples corridas HTTP.
- ⚠️ El **auto-chequeo dentro de la misma generación** (¿ya pregunté esto en el texto que estoy por mandar?) sigue fallando en aproximadamente la mitad de los casos probados.

**Por qué no se puede cerrar del todo:** pedirle al modelo que audite su propia respuesta dentro de la misma pasada de generación (extraer Y preguntar Y verificar consistencia interna, todo a la vez) es una categoría de tarea distinta y menos confiable que leer un dato ya servido como contexto externo (que es como funciona el mecanismo cross-turno, ver más abajo).

## Limitación 2 — Repetición cross-turno (variabilidad del LLM)

**Síntoma:** encontrado en pruebas HTTP del 2026-07-09 (8 escenarios conversacionales reales). En 2 de 4 escenarios de flujo normal, la IA repitió la pregunta de automedicación en un turno posterior (turno 2 o turno 3), **pese a que `askedTopics` ya tenía el tema registrado desde el turno 1** y el bloque `[Progreso de la consulta]` se lo indicaba explícitamente en el prompt.

**Evidencia:**
- Consulta de prueba con turnos servidos 100% por `bedrock/openai.gpt-oss-20b`: repitió la pregunta de automedicación del turno 1 al turno 3.
- Consulta de prueba con fallback `bedrock → gemini/gemini-2.5-flash-lite → bedrock`: repitió del turno 1 al turno 2.
- En una corrida anterior (2026-07-09, sesión previa el mismo día) el mismo escenario dio 4/4 sin repetición. Esta corrida dio 2/4 con repetición.

**Conclusión:** no es un bug de datos (el código guarda y expone `askedTopics` correctamente en todos los casos verificados) ni parece atado a un proveedor específico (pasó tanto con Bedrock como con Gemini). Es variabilidad de cumplimiento de instrucciones inherente al LLM — la misma instrucción, con el mismo contexto correcto, no se sigue el 100% de las veces.

**No confirmado (hipótesis, no probada):** la sección "ESCALAMIENTO INMEDIATO" agregada al prompt el 2026-07-09 (para la detección de emergencias) alargó el prompt; es posible que eso diluya el cumplimiento de otras instrucciones, pero con solo 2 fallos sobre 4 muestras no alcanza para afirmar causalidad. Requeriría un A/B con más muestras para confirmar o descartar.

## Qué NO es una limitación (control ya validado)

Para que quede explícito qué SÍ funciona de forma confiable, evitando que se re-audite innecesariamente:
- Detección de emergencia (`isEmergency`) y bloqueo de la consulta: 4/4 en pruebas dedicadas, incluyendo un control negativo (síntoma fuerte sin señales de alarma reales) que NO disparó falso positivo.
- El mensaje fijo de emergencia se persiste byte-a-byte idéntico al texto aprobado — verificado programáticamente, no solo por lectura visual.
- El bloqueo de una consulta ya marcada como emergencia nunca vuelve a invocar al LLM (confirmado vía `metadata.provider=null` en los turnos re-servidos).

## Postura actual

No se está tratando de forzar un 100% de cumplimiento por prompt — sería perseguir un techo que el enfoque actual no puede garantizar. Si en el futuro esta tasa de repetición se vuelve un problema de producto (no solo de pruebas), las alternativas a evaluar serían:
1. Validación determinística post-generación: si el `topicAsked` que reporta el LLM coincide con un tema ya en `askedTopics`, rechazar la respuesta y forzar un reintento con un recordatorio explícito.
2. Bajar la temperatura del modelo para este tipo de llamada (a costa de respuestas más rígidas/menos naturales).
3. Aceptar la tasa actual y priorizar otros frentes — el impacto clínico de una pregunta repetida es bajo (molestia, no riesgo), a diferencia de la detección de emergencias.

Por ahora se optó por documentar y seguir, no por bloquear el commit de la feature de emergencia por esto.
