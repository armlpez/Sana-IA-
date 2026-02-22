Qué buen reto técnico tienes entre manos. Para SANA, no estás construyendo un simple formulario, estás diseñando un Motor de Inferencia Clínica.Para que el backend sea robusto, debes entender que en medicina el diagnóstico de "Gastritis" es engañoso: el paciente dice que tiene "gastritis" (síntoma), pero el médico solo puede diagnosticar "gastritis" (patología) oficialmente mediante una biopsia.Aquí tienes el "Maestro de Procedimiento" estructurado para tu lógica de backend:💡 El Algoritmo Maestro de Evaluación ClínicaEste procedimiento se divide en 5 capas lógicas que tu sistema debe procesar secuencialmente.1. Capa de Triaje y "Red Flags" (Filtro de Seguridad)Antes de preguntar si te duele la panza, el sistema debe descartar que el paciente se esté desangrando o tenga un infarto (que a veces se siente como dolor en la boca del estómago).Preguntas Críticas:¿Heces negras (como petróleo) o con sangre? (Melena)¿Vómito con sangre o aspecto de "borra de café"? (Hematemesis)¿Pérdida de peso involuntaria y rápida?¿Dificultad para tragar? (Disfagia)Acción del Backend: Si true en cualquiera, el sistema interrumpe el flujo y dispara una Alerta de Emergencia.2. Anamnesis Dirigida (Recolección de Atributos)Aquí aplicamos la mnemotecnia ALICIA para caracterizar el dolor. Para una gastritis, el sistema buscaría estos valores:AtributoValor Sugestivo de GastritisAparición¿Cuándo empezó? (Agudo vs. Crónico).LocalizaciónEpigastrio (la "boca del estómago").IntensidadVariable, pero suele ser persistente.CarácterUrente (ardor/quemazón) o sensación de vacío.IrradiaciónGeneralmente no se irradia (si se va a la espalda, pensar en páncreas).Atenuación¿Empeora con la comida (gastritis) o mejora (úlcera duodenal)?3. Análisis de Etiología (Factores de Riesgo)Un médico no solo mira el síntoma, busca el agente causal. Tu base de datos debe cruzar el dolor con:Uso de AINEs: ¿Toma aspirina, ibuprofeno o diclofenaco frecuentemente? (Causa química principal).Infección: ¿Vive en zonas con agua no tratada? (Sospecha de Helicobacter pylori).Hábitos: Consumo de alcohol, tabaquismo, exceso de cafeína.Estrés: ¿Ha tenido cirugías recientes o traumas graves? (Gastritis por estrés).4. Diagnóstico Diferencial (La Lógica de Exclusión)El "pivote" debe ser capaz de dudar. Si el paciente tiene dolor en el epigastrio, el médico considera:Colelitiasis: Cálculos en la vesícula (el dolor suele ser tras comer grasa y se va al hombro derecho).ERGE: Reflujo gastroesofágico (el ardor sube al pecho).Pancreatitis: Dolor "en cinturón" que atraviesa la espalda.Dispepsia Funcional: Dolor sin causa orgánica visible.5. Confirmación Oficial (El "Gold Standard")Para que el diagnóstico sea oficial y legal, el procedimiento médico dicta:Endoscopia Digestiva Superior (EDS): El médico introduce una cámara para ver la mucosa. Si hay enrojecimiento (eritema), hay sospecha visual.Biopsia Gástrica: Este es el punto final. Se toma una muestra de tejido y el patólogo confirma bajo el microscopio la presencia de células inflamatorias.Test de H. pylori: Puede ser por aliento, sangre o heces, para determinar si la causa es bacteriana.🛠 Estructura Sugerida para tu "Función Maestra" en el BackendSi estuvieras escribiendo esto en pseudocódigo o lógica de objetos, se vería así:JSON{
  "evaluacion": {
    "paciente_id": "uuid",
    "fase_1_emergencia": "pass/fail", 
    "fase_2_anamnesis": {
      "dolor_tipo": "urente",
      "localizacion": "epigastrio",
      "puntuacion_probabilidad": 0.85
    },
    "fase_3_exposicion": [
      {"factor": "uso_aines", "riesgo": "alto"},
      {"factor": "alcohol", "riesgo": "medio"}
    ],
    "fase_4_exclusion": {
      "descarte_vesicula": true,
      "descarte_cardiaco": true
    },
    "fase_5_confirmacion_requerida": [
      "Endoscopia",
      "Test_H_Pylori"
    ]
  }
}
Consideraciones Finales para SANA:La Carga de la Prueba: No permitas que el sistema dé un diagnóstico definitivo de "Gastritis" sin una validación médica/histológica. Etiquétalo como "Sugerencia diagnóstica: Dispepsia / Probable Gastritis".Empatía del Sistema: El médico siempre pregunta "¿Cómo afecta esto tu vida?". Incluir un campo de impacto en la calidad de vida ayuda a priorizar la urgencia de la cita.¿Te gustaría que profundicemos en cómo estructurar el árbol de decisiones para separar la gastritis de un problema de vesícula?
