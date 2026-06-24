# Escalabilidad de Almacenamiento - OCR Storage Service

## 🎯 Problema

Actualmente el OCR usa **almacenamiento local en disco** (`/uploads/labs/`), lo que causa 3 problemas críticos:

### 1. Disco se llena indefinidamente
```
Scenario: 100 usuarios suben 10MB de imágenes cada uno
Result: 1GB guardado en disco
Problem: Nunca se borra → después de 1000 uploads = 10GB → CRASH
```

### 2. **Multi-pod/Kubernetes FALLA** (Critical for scaling)
```
Pod-1: Usuario A sube imagen
  ✅ Guardada en Pod-1:/uploads/labs/image.jpg
  ✅ DB guarda path absoluto: "/app/uploads/labs/image.jpg"

Pod-2: BullMQ elige este pod para procesar
  ❌ Intenta leer: "/app/uploads/labs/image.jpg"
  ❌ ARCHIVO NO EXISTE (está en Pod-1)
  ❌ JOB FALLA silenciosamente
  ❌ Usuario: sin resultado, sin error claro
```

### 3. **PHI sin encriptación**
- Laboratorios guardados en plain text en disco
- `.gitignore` roto: `uploads/labs/` podría quedar en git
- Compliance violation para datos de salud

---

## ✅ Solución: StorageService (Abstracción)

Creamos una capa que abstrae dónde se guardan los archivos:

```typescript
// Hoy (Local):
await storageService.getFile('/uploads/labs/image.jpg')

// Mañana (S3 - SIN CAMBIOS en llamadores):
await storageService.getFile('labs/image.jpg')  // StorageService mapea a S3
```

### Ventajas
- ✅ **Cambio cero en OCR worker code** - solo importa StorageService
- ✅ **Switcheable** - entre local y S3 por variable de entorno
- ✅ **Cleanup automático** - S3 lifecycle rules
- ✅ **Multi-pod ready** - S3 es compartido entre pods
- ✅ **PHI segura** - S3 encryption at rest

---

## 📋 Fases de Implementación

### Fase 1: Abstracción (DONE - 2-3h)
```
✅ Crear StorageService con métodos:
  - getFile(path): Promise<Buffer>
  - deleteFile(path): Promise<void>
  - storeFromDisk(source, dest): Promise<string>
  - extractMimeType(path): string

✅ Implementar local disk backend (MVP)

✅ Integrar en OCR worker + cleanup
```

### Fase 2: LocalStack (DONE - 3-5h)
Para testing sin AWS real:
```bash
# docker-compose.yml agregar:
localstack:
  image: localstack/localstack
  environment:
    SERVICES: s3
    STORAGE_TYPE: localstack  # ← ENV var
```

Implementar en StorageService:
```typescript
// if (this.storageType === 's3') {
//   const s3 = new S3Client({
//     endpoint: 'http://localstack:4566'
//   })
//   await s3.getObject(Bucket: 'sana-ocr', Key: storagePath)
// }
```

### Fase 3: AWS S3 (1-2d)
Cuando escales a producción:
```bash
# .env
STORAGE_TYPE=s3
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=***
AWS_SECRET_ACCESS_KEY=***
S3_BUCKET=sana-ocr
```

**Zero code changes** - solo cambiar StorageService constructor

---

## 🚀 Por Qué Este Enfoque (MVP + Escalable)

| Aspecto | Local | LocalStack | AWS S3 |
|---------|-------|-----------|--------|
| **Complejidad** | Muy bajo | Medio | Medio |
| **Costo** | $0 | $0 | ~$2-5/mes |
| **Multi-pod** | ❌ Falla | ✅ Funciona | ✅ Funciona |
| **PHI Encryption** | ❌ No | ✅ Configurable | ✅ Sí |
| **File Cleanup** | ❌ Manual | ✅ Automático | ✅ Automático |
| **Deployment** | dev machine | Docker | AWS |

### Timeline Recomendado

**Semana 1 (MVP):**
- StorageService abstraction
- Local backend (already have)
- Cleanup logic
- **Total: 2-3h**

**Semana 2-3 (antes de escalar):**
- Docker Compose con LocalStack
- StorageService S3 backend
- Testing multi-pod
- **Total: 3-5h**

**Cuando escales (Producción):**
- Cambiar ENV vars a AWS
- Create S3 bucket + lifecycle rules
- Deploy
- **Total: 1h**

---

## 🔐 Configuración de S3 (cuando llegues)

### Bucket Lifecycle Rules (auto-cleanup)
```json
{
  "Rules": [
    {
      "Filter": { "Prefix": "ocr/" },
      "Expiration": { "Days": 7 },
      "Status": "Enabled"
    }
  ]
}
```
→ Archivos se borran automáticamente después de 7 días

### Encryption at Rest
```
AWS → S3 → Bucket settings → Default encryption → AES-256
```
→ Todos los archivos encrypted automáticamente

---

## 📝 Checklist

### MVP (Hoy)
- [ ] StorageService creada con métodos abstractos
- [ ] Local backend implementado
- [ ] OCR worker integrado
- [ ] Cleanup en finally block
- [ ] Rutas relativas guardadas (no absolutas)

### Escalado (Next sprint)
- [ ] LocalStack en docker-compose
- [ ] S3 backend en StorageService
- [ ] Integration tests multi-pod
- [ ] Production AWS setup docs

---

## 🎬 Cómo Empezar

1. **Hoy**: Merge StorageService + local cleanup (2-3h)
2. **Mañana**: Opción A (LocalStack) o Opción B (AWS)
3. **Próxima semana**: Multi-pod testing
4. **Producción**: Cambiar ENV var a AWS

**Result**: Same code, runs everywhere (local/multi-pod/AWS) ✅
