# Fase 4: ReportsModule — Generación de PDFs de Consulta

## 🎯 Objetivo
Permitir que usuarios exporten consultas completas (síntomas, diagnósticos, biomarkers de OCR) como **PDF descargable**, con privacidad y seguridad garantizadas.

---

## 📋 Requerimientos Funcionales

### RF-1: Generar PDF de Consulta
**Como usuario**, quiero descargar un reporte PDF de mi consulta (síntomas + diagnóstico + biomarkers)

**Criterios de aceptación:**
- ✅ POST `/v1/reports/generate/{consultationId}` → retorna PDF binario
- ✅ PDF incluye:
  - Datos del paciente (nombre, edad, email — NO mostrar contraseña)
  - Síntomas reportados
  - Diagnóstico + probabilidad
  - Recomendaciones de especialista
  - Biomarkers extraídos del OCR (si existen)
  - Fecha de generación + disclaimer legal
- ✅ Nombre archivo: `consultation-{consultationId}-{fecha}.pdf`
- ✅ Header: `Content-Type: application/pdf`

### RF-2: Incluir Biomarkers del OCR
**Como usuario**, quiero que el PDF incluya los valores de laboratorio que subí

**Criterios de aceptación:**
- ✅ Si hay OCR results para la consulta, incluir tabla:
  - Biomarker | Valor | Unidad | Rango Referencia | Flag (Normal/Alto/Bajo)
- ✅ Mencionar fecha del examen + confianza de extracción
- ✅ Si no hay OCR, mostrar: "No hay resultados de laboratorio adjuntos"

### RF-3: Seguridad & Privacidad
**Como usuario**, quiero asegurar que mi reporte es privado y solo yo puedo descargarlo

**Criterios de aceptación:**
- ✅ Validar ownership: solo el usuario que creó la consulta puede descargar
- ✅ No cachear PDF en disco (generar en memoria)
- ✅ NO incluir PHI sensible: historial de cambios, logs internos, paths del servidor
- ✅ Sanitizar texto: solo información clínica + recomendaciones

### RF-4: Auditoría
**Como administrador**, quiero saber cuándo se descargó un reporte

**Criterios de aceptación:**
- ✅ Crear `ReportDownload` entity:
  - userId, consultationId, downloadedAt, userAgent
- ✅ Log: `[REPORT] Downloaded consultation-{id} by user {userId}`
- ✅ No exponer en API pública (solo admin)

### RF-5: Errores Graceful
**Como usuario**, quiero un mensaje claro si hay problemas

**Criterios de aceptación:**
- ✅ Consulta no existe → 404 "Consultation not found"
- ✅ No soy el dueño → 403 "You don't have access to this consultation"
- ✅ Falló generación PDF → 500 "Failed to generate report" (sin detalles técnicos)
- ✅ Consulta sin diagnosis aún → 400 "Report cannot be generated for incomplete consultation"

---

## 🏗️ Diseño Técnico

### Stack
- **PDF Generation**: `pdfkit` o `puppeteer` (elige uno)
  - `pdfkit`: más ligero, sin navegador, perfecto para text+tablas
  - `puppeteer`: más visual, perfecto si querés HTML renderizado
- **Database**: `ReportDownload` entity + migration
- **Storage**: En memoria (Buffer), no guardar en disco

### Arquitectura

```
ReportsModule
├── reports.controller.ts
│   └── POST /v1/reports/generate/:consultationId
│
├── reports.service.ts
│   ├── generatePDF(consultationId, userId): Buffer
│   ├── buildHeader(): string
│   ├── buildSymptomSection(): string
│   ├── buildDiagnosisSection(): string
│   ├── buildBiomarkersTable(): string
│   └── buildFooter(): string
│
├── report-download.entity.ts
│   └── userId, consultationId, downloadedAt, userAgent
│
├── templates/
│   └── consultation-report.template.ts
│       └── formatPDF(): DocumentDefinition (si usas pdfkit o similar)
│
└── reports.module.ts
    └── Imports: ConsultationsModule, OcrModule, UsersModule
```

### Data Flow
```
POST /v1/reports/generate/12
  ↓
[Auth Guard] → verify userId owns consultation 12
  ↓
ConsultationService.findById(12) → get symptoms, diagnosis, status
  ↓
OcrService.findByConsultationId(12) → get biomarkers
  ↓
ReportsService.generatePDF(consultation, biomarkers)
  ├─ Render HTML template
  ├─ Include: name, symptoms, diagnosis, biomarkers table
  └─ Convert to PDF (pdfkit or puppeteer)
  ↓
[Audit] ReportDownloadService.log(userId, consultationId)
  ↓
Response: PDF binary + headers
```

---

## 🧪 Pruebas de Aceptación

### Test Suite: ReportsController

#### ✅ TA-1: Generate PDF - Happy Path
```typescript
describe('POST /v1/reports/generate/:consultationId', () => {
  it('should return PDF binary with correct headers', async () => {
    // Setup: create consultation + diagnosis
    const consultation = await consultationRepo.save({
      userId: 1,
      status: 'completed',
      extractedData: { symptoms: 'fiebre' },
      diagnosis: { rootCauseHypothesis: 'Gripe', confidenceLevel: 80 }
    });

    const response = await request(app.getHttpServer())
      .post(`/v1/reports/generate/${consultation.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Assert
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.body).toBeInstanceOf(Buffer);
    expect(response.body.length).toBeGreaterThan(1000); // PDF is not trivial
    expect(response.headers['content-disposition']).toMatch(/consultation-\d+-\d{4}/);
  });
});
```

#### ✅ TA-2: Include Biomarkers
```typescript
it('should include OCR biomarkers in PDF', async () => {
  // Setup: consultation + OCR result
  const consultation = await consultationRepo.save({
    userId: 1,
    status: 'completed'
  });

  await ocrResultRepo.save({
    consultationId: consultation.id,
    extractedData: {
      biomarkers: [
        { name: 'Hemoglobina', value: '15.5', unit: 'g/dL', flag: 'normal' }
      ]
    },
    status: 'completed'
  });

  const response = await request(app.getHttpServer())
    .post(`/v1/reports/generate/${consultation.id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  // Verify PDF contains biomarker data
  const pdfText = await extractTextFromPDF(response.body);
  expect(pdfText).toContain('Hemoglobina');
  expect(pdfText).toContain('15.5');
  expect(pdfText).toContain('g/dL');
});
```

#### ✅ TA-3: Ownership Validation
```typescript
it('should reject if user is not consultation owner', async () => {
  const otherUserToken = 'jwt-for-user-999';

  const response = await request(app.getHttpServer())
    .post(`/v1/reports/generate/${consultation.id}`)
    .set('Authorization', `Bearer ${otherUserToken}`)
    .expect(403);

  expect(response.body.errorCode).toBe('ERR_FORBIDDEN');
});
```

#### ✅ TA-4: Incomplete Consultation
```typescript
it('should reject if consultation status is "collecting"', async () => {
  const incompleteConsultation = await consultationRepo.save({
    userId: 1,
    status: 'collecting' // ← not completed
  });

  const response = await request(app.getHttpServer())
    .post(`/v1/reports/generate/${incompleteConsultation.id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(400);

  expect(response.body.message).toContain('cannot be generated');
});
```

#### ✅ TA-5: Audit Log
```typescript
it('should log report download', async () => {
  const response = await request(app.getHttpServer())
    .post(`/v1/reports/generate/${consultation.id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  // Verify audit entry
  const auditLog = await reportDownloadRepo.findOne({
    where: { consultationId: consultation.id, userId: 1 }
  });

  expect(auditLog).toBeDefined();
  expect(auditLog.downloadedAt).toBeCloseTo(new Date(), 5000); // ±5s
});
```

#### ✅ TA-6: Not Found
```typescript
it('should return 404 if consultation does not exist', async () => {
  const response = await request(app.getHttpServer())
    .post(`/v1/reports/generate/99999`)
    .set('Authorization', `Bearer ${token}`)
    .expect(404);

  expect(response.body.errorCode).toBe('ERR_CONSULTATION_NOT_FOUND');
});
```

#### ✅ TA-7: No PHI Leakage
```typescript
it('should not include server paths or internal details', async () => {
  const response = await request(app.getHttpServer())
    .post(`/v1/reports/generate/${consultation.id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  const pdfText = await extractTextFromPDF(response.body);

  // Assert NO server paths
  expect(pdfText).not.toContain('/home/armando');
  expect(pdfText).not.toContain('src/');
  expect(pdfText).not.toContain('Error:');
  expect(pdfText).not.toContain('stack');
});
```

---

## 📦 Deliverables

### Code
- `src/reports/reports.controller.ts`
- `src/reports/reports.service.ts`
- `src/reports/report-download.entity.ts`
- `src/reports/reports.module.ts`
- `src/reports/templates/consultation-report.template.ts`
- `src/database/migrations/*CreateReportDownloadTable.ts`

### Tests
- `src/reports/reports.controller.spec.ts` (7 test cases)
- `src/reports/reports.service.spec.ts` (PDF generation, data inclusion)

### Docs
- `docs/REPORTS-API.md` (API documentation)
- `docs/FASE4-SUMMARY.md` (implementation summary)

---

## 🚀 Deployment Checklist

- [ ] PDF generation tested locally
- [ ] No PHI leakage verified
- [ ] All 7 acceptance tests passing
- [ ] Audit logs working
- [ ] Error handling for all edge cases
- [ ] Performance: PDF generated in <2s
- [ ] Tested with large biomarker tables (10+ rows)
- [ ] Database migration applied
- [ ] Documentation updated

---

## 📊 Acceptance Criteria Summary

| Criterio | Test | Status |
|----------|------|--------|
| Generate PDF | TA-1 | ⏳ TODO |
| Include Biomarkers | TA-2 | ⏳ TODO |
| Ownership Check | TA-3 | ⏳ TODO |
| Incomplete Consultation | TA-4 | ⏳ TODO |
| Audit Logging | TA-5 | ⏳ TODO |
| Not Found | TA-6 | ⏳ TODO |
| No PHI Leakage | TA-7 | ⏳ TODO |

---

## 🔄 Dependencies

**Requires (already complete):**
- ✅ Fase 1: Auth + Users
- ✅ Fase 2: Chat + AI
- ✅ Fase 3: OCR + BullMQ

**Blocked by:**
- None — can start immediately

---

## ⏱️ Estimated Effort

| Task | Hours |
|------|-------|
| Controller + Service | 3-4h |
| PDF Template | 2-3h |
| Tests (7 TA) | 2-3h |
| Audit + Migration | 1h |
| **Total** | **8-11h** |

---

## 📝 Notes

- **PDF Library Choice**: Usar `pdfkit` por simplicidad y performance. Si necesitas diseño complejo, usar `puppeteer`.
- **In-Memory Generation**: No guardar PDFs en disco — genera, envía, descarta. Mejor para privacidad y escalabilidad.
- **Biomarkers Display**: Si hay muchos biomarkers, usar tabla paginada o resumen (top 10 abnormal).
- **Future Enhancement**: Agregar exportar a Excel, CSV, XML para análisis automático.
