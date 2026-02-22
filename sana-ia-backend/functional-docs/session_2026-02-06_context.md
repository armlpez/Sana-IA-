# Sesión de Trabajo SANA - 6 de Febrero 2026

## 📋 Resumen de la Sesión

Esta sesión cubrió aspectos críticos del diseño del sistema SANA, enfocándose en el flujo conversacional, persistencia de datos y arquitectura del módulo de IA.

---

## 🎯 Temas Cubiertos

### 1. Análisis del JSON de Respuesta de la IA

La respuesta del análisis ACR tiene esta estructura:

```json
{
  "statusInconsistency": true,
  "detectedBiomarkers": [],
  "rootCauseHypothesis": "Hipótesis de causa raíz",
  "suggestedSpecialist": "Endocrinólogo",
  "confidenceLevel": 85,
  "requiresHardData": true,
  "isEmergency": false,
  "disclaimer": "Aviso legal obligatorio",
  "fiveWhysTrace": ["1. ¿Qué?", "2. ¿Por qué?", ...]
}
```

| Campo | Propósito |
|-------|-----------|
| `statusInconsistency` | Si (Fármaco + Tiempo) ≠ Resultado esperado |
| `detectedBiomarkers` | Array de biomarcadores de laboratorio |
| `rootCauseHypothesis` | Patología probable basada en ACR |
| `suggestedSpecialist` | Especialista recomendado |
| `confidenceLevel` | 0-100, nivel de confianza |
| `requiresHardData` | Si necesita laboratorios para confirmar |
| `isEmergency` | Si requiere atención inmediata |
| `fiveWhysTrace` | Rastro del algoritmo de los 5 Porqués |

---

### 2. Algoritmo de los 5 Porqués

El núcleo del sistema SANA basado en la metodología R.F.G.:

```
1. ¿Qué síntomas? → Identifica síntomas principales
2. ¿Qué tratamiento? → Analiza terapia actual
3. ¿Cuánto tiempo sin mejoría? → Evalúa progresión
4. ¿Hay inconsistencia? → Si (Fármaco + Tiempo) ≠ Resultado esperado
5. ¿Causa raíz? → Hipótesis basada en correlación de datos
```

**Implementación:** A través del System Prompt, NO entrenamiento personalizado.

---

### 3. Entrenamiento del Modelo

**SANA no entrena un modelo propio.** Usa Gemini pre-entrenado con personalización vía:

| Método | Qué es | Costo |
|--------|--------|-------|
| **Prompt Engineering** ✅ | Instrucciones en System Prompt | Gratis |
| **Few-shot Learning** | Ejemplos en el prompt | Gratis |
| **RAG** | Base de datos médica externa | Variable |
| **Fine-tuning** | Re-entrenar con datos propios | $$$$ |

---

### 4. Razón de Persistir Datos

#### ¿Por qué guardar cada entidad?

| Entidad | Razón principal |
|---------|-----------------|
| `CONSULTATIONS` | Historial, contexto para la IA, auditoría |
| `SYMPTOMS` | Perfil de salud, ML, correlaciones |
| `LAB_RESULTS` | Evidencia objetiva, seguimiento de valores |
| `DIAGNOSIS` | Trazabilidad, responsabilidad legal |
| `RECOMMENDATIONS` | Medir efectividad, recordatorios |
| `DISEASES` | Estandarización CIE-10, interoperabilidad |
| `SPECIALISTS` | Recomendaciones precisas, consistencia |

---

### 5. Flujo Conversacional vs Formulario

**Problema:** El endpoint actual `/ai/analyze` espera JSON estructurado.

**Solución:** Nuevo endpoint `/ai/chat` con flujo conversacional.

```
ACTUAL (Formulario)              IDEAL (Chat)
────────────────────             ───────────────
JSON estructurado ──►            Usuario: "Hola, me siento mal"
{                                       ↓
  symptoms,                      IA: "¿Qué síntomas tienes?"
  treatment,                            ↓
  duration                       [Conversación gradual]
}                                       ↓
      ↓                          [Cuando tiene toda la info]
Análisis directo                        ↓
                                 Análisis ACR
```

---

### 6. Campo Summary en Consultas

**Propósito:** Capturar resumen actualizado de la conversación.

```typescript
CONSULTATIONS {
    id: uuid
    summary: json/text     // ← NUEVO: Resumen actualizado
    status: 'collecting' | 'analyzing' | 'completed'
    extracted_symptoms: string | null
    extracted_treatment: string | null
    extracted_duration: string | null
}
```

**Formato del summary:**
```json
{
  "mainComplaint": "Poliuria, polidipsia",
  "currentTreatment": "Ninguno",
  "duration": "3 semanas",
  "suspectedCondition": "Diabetes Mellitus",
  "isComplete": true
}
```

---

### 7. Estrategia de Persistencia

| Entidad | Estrategia | Frecuencia |
|---------|------------|------------|
| `CONSULTATION` | CREAR 1 vez, ACTUALIZAR después | Por sesión |
| `CHAT_MESSAGES` | CREAR nuevo registro | Por mensaje |
| `DIAGNOSIS` | CREAR cuando se completa análisis | 1 por consulta |

**Flujo:**
```
Inicio chat → CREAR Consultation
    ↓
Cada mensaje → CREAR ChatMessage + ACTUALIZAR Consultation.summary
    ↓
Análisis completo → ACTUALIZAR status + CREAR Diagnosis
```

---

## 📝 Decisiones de Diseño Tomadas

1. ✅ **Mantener ambos endpoints**: `/ai/analyze` para APIs + `/ai/chat` para UX conversacional
2. ✅ **Summary en Consultation**: Campo JSON actualizado automáticamente
3. ✅ **ChatMessages inmutables**: Nunca se actualizan, solo se crean nuevos
4. ✅ **IA genera el summary**: El System Prompt incluirá instrucciones para generar summary
5. ✅ **MVP de persistencia**: Empezar con Consultations + Diagnosis + ChatMessages

---

## 🚀 Próximos Pasos

1. [ ] Crear entidad `Consultation` con campo `summary`
2. [ ] Crear entidad `ChatMessage`
3. [ ] Crear endpoint `POST /ai/chat`
4. [ ] Modificar System Prompt para modo conversacional
5. [ ] Implementar lógica de actualización de summary
6. [ ] Crear endpoint para obtener historial de conversaciones

---

## 📁 Archivos Relacionados

- `functional-docs/database_schema.md` - Schema original
- `functional-docs/database_and_flows.md` - Diagramas y flujos
- `src/ai/prompts/system-prompt.ts` - System Prompt actual
- `src/ai/schemas/ai-response.schema.ts` - Schema Zod de respuesta
