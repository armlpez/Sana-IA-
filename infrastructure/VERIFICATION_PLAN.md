# SANA-IA — Plan de Verificación y Próximos Pasos

Estado al momento de escribir esto. Retomar desde acá.

---

## Datos clave del deploy actual

| Recurso | Valor |
|---|---|
| Stack | `sana-ia-dev` (región `us-east-1`) |
| Backend URL | `http://44.198.177.129:3000` |
| Instance ID | `i-05add038675565a05` |
| DB Endpoint | `sana-db-dev.cu3is0yownst.us-east-1.rds.amazonaws.com` |
| S3 Bucket | `sana-ia-labs-dev-403873843175` |
| Cuenta AWS | `403873843175` (personal) |

Conexión a la EC2 (sin SSH): `aws ssm start-session --target i-05add038675565a05 --region us-east-1`

---

## ✅ Ya resuelto (infraestructura + código)

1. **Infra desplegada**: 6 stacks (network, secrets, storage, iam, database, compute) — `sam deploy --config-env dev` en `infrastructure/`.
2. **Bug Unicode**: em-dashes (`—`) en `GroupDescription`/`DBSubnetGroupDescription`/etc. rompían la creación de recursos (EC2/RDS rechazan caracteres no-ASCII). Corregido en todos los templates.
3. **Permisos IAM**: `PowerUserAccess` excluye `iam:*` a propósito. Se agregó política least-privilege (`infrastructure/bootstrap/deployer-iam-policy.json`, documentada en `README.md`) para que `sana-dep` pueda crear el Role/InstanceProfile del backend.
4. **Código de la app nunca estaba en GitHub**: el refactor de storage (Ports & Adapters), `Dockerfile`, y el servicio `app` en `docker-compose.yml` vivían solo en el working directory local. Ya se hizo push a `main`.
5. **`buildx` desactualizado**: el `docker-buildx` que trae `dnf` en Amazon Linux 2023 es muy viejo para el Docker Compose CLI "latest". Se agregó fetch de la última versión al `UserData` de `compute/template.yml`.
6. **RDS exige SSL**: TypeORM no tenía `ssl` configurado → error `no pg_hba.conf entry ... no encryption`. Agregado `DB_SSL=true` + `ssl: process.env.DB_SSL === 'true' ? {...} : false` en `database.config.ts`, `database.module.ts`, `data-source.ts`.
7. **Backend confirmado accesible públicamente**: `GET /health` → `200 {"status":"ok",...}` desde fuera de AWS.

---

## ✅ Verificación completa (login funcionando)

**Login confirmado con ambos usuarios semilla** — endpoint correcto es `/v1/auth/login` (no `/auth/login`, el proyecto usa `VersioningType.URI` en `main.ts`):

```bash
curl -X POST http://44.198.177.129:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@gmail.com","password":"12345678"}'
# → 201 { access_token, refresh_token, user: { role: "admin", ... } }
```

Dos problemas más aparecieron y se resolvieron durante esta verificación:

1. **La instancia t3.micro se quedó sin créditos de CPU** (burstable) tras varios rebuilds de Docker seguidos en la sesión → un `docker compose up --build` quedó colgado 15+ min con CPU "idle" (en realidad throttleada al mínimo). Efecto secundario: SSM solo procesa **un comando a la vez por instancia** — al quedar el build atascado, todos los comandos de diagnóstico posteriores quedaron en cola ("Pending/Delayed") sin poder ejecutar, dando la falsa impresión de que todo estaba roto. Solución: `aws ssm cancel-command` + `aws ec2 reboot-instances`. Tras el reboot, los créditos se recuperaron y el deploy corrió normal (~80 seg).
   - **Si vuelve a pasar**: revisar `CPUCreditBalance` en CloudWatch antes de asumir que algo está colgado. Evitar mandar varios comandos SSM en paralelo mientras uno sigue `InProgress` — se van a encolar y van a parecer todos colgados por igual.
   - Si los rebuilds van a ser frecuentes, considerar cambiar el modo de créditos de la instancia a "Unlimited" (costo extra menor) o espaciar más los deploys.

2. **Los primeros intentos de login dieron 404** — pero era un falso positivo: probé `/auth/login` en vez de `/v1/auth/login`. El filtro de excepciones global (`common/filters/exception.filter.ts`) mapea CUALQUIER 404 al código `ERR_USER_001` (`USER_NOT_FOUND`) sin importar la causa real — por eso un 404 de ruta inexistente se ve idéntico a un 404 de "usuario no encontrado" en el cuerpo de la respuesta. Ojo con esto para debugging futuro: no confiar en el `errorCode` literal cuando el status es 404, revisar primero el path real.

---

## ⏳ (Histórico) En verificación — ya resuelto, dejado como referencia

El proyecto **no tiene migraciones completas** — solo 2 migraciones incrementales que asumen que las tablas base (`user`, `role`, `consultation`, etc.) ya existen (venían de `synchronize: true` en desarrollo local). Contra una RDS nueva, correr solo esas 2 migraciones falla con `relation "consultation" does not exist`.

**Decisión tomada**: agregar variable `DB_SYNCHRONIZE` independiente de `NODE_ENV`, para no confundir "producción" con "sin SSL/logging" (ver `database.config.ts`). Con `DB_SYNCHRONIZE=true`, TypeORM crea todo el schema directo desde las entidades al arrancar — **no hace falta correr las 2 migraciones manualmente** (mezclarlas con synchronize podría dar conflictos de "relation already exists").

Un subagente quedó ejecutando, en orden:
1. Re-sincronizar `/opt/sana-ia/deploy.sh` en la EC2 (agregando `DB_SYNCHRONIZE=true` al `.env` generado) — **necesario porque el script en disco NO se actualiza solo** cuando cambia `compute/template.yml`; hay que reescribirlo a mano vía SSM cada vez.
2. Correr `sudo /opt/sana-ia/deploy.sh` (pull del código + rebuild + restart).
3. Verificar en `docker logs sana-backend` que TypeORM conecte sin errores.
4. Correr el seed: `docker exec sana-backend node dist/database/seeds/run-seeds.js` (crea roles ADMIN/USER + usuarios).
5. Probar login con los dos usuarios semilla.

### Cómo retomar / verificar esto vos mismo

```bash
# 1. Ver logs del backend
aws ssm send-command --instance-ids i-05add038675565a05 --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo docker logs sana-backend --tail 50"]' --region us-east-1 \
  --query "Command.CommandId" --output text
# (esperar unos segundos, luego)
aws ssm get-command-invocation --command-id <ID> --instance-id i-05add038675565a05 --region us-east-1

# 2. Probar login (usuarios semilla, password igual para ambos)
curl -X POST http://44.198.177.129:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@gmail.com","password":"12345678"}'

curl -X POST http://44.198.177.129:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@gmail.com","password":"12345678"}'
```

**Resultado esperado**: `200`/`201` con un JWT. Si da `401`, el seed no corrió o falló. Si da `500`/conexión rechazada, revisar `docker logs sana-backend`.

### Usuarios semilla (`user.seeder.ts`)
| Email | Password | Rol |
|---|---|---|
| `admin@gmail.com` | `12345678` | ADMIN |
| `user@gmail.com` | `12345678` | USER |

---

## ❌ Pendiente

### 1. Migración a S3 (código ya existe, falta activarlo)

El adapter S3 (`src/storage/adapters/s3-storage.adapter.ts`) está **completo e implementado** — credenciales del instance role, encriptación AES256, interfaz `StoragePort` completa. Lo que falta es activarlo en este deploy (hoy corre con `STORAGE_TYPE=local`):

```bash
cd infrastructure
sam deploy --config-env dev --parameter-overrides StorageType=s3
```

Después, **re-sincronizar `deploy.sh` en la EC2** (mismo proceso manual de siempre — cambiar `STORAGE_TYPE=local` → `STORAGE_TYPE=s3` en el `.env` generado) y correr `sudo /opt/sana-ia/deploy.sh` de nuevo.

⚠️ **Importante**: no mezclar este cambio con otra cosa — hacerlo en un paso separado para no perder trazabilidad de qué rompe qué (lección aprendida esta sesión con varios bugs encadenados).

### 2. Redis sin persistencia (riesgo de pérdida de jobs)

`docker-compose.yml`:
```yaml
redis:
  command: redis-server --appendonly no --maxmemory 128mb --maxmemory-policy allkeys-lru
```

- Sin volumen, sin AOF (`appendonly no`) → si el container de Redis se reinicia, **se pierden los jobs de BullMQ en cola o en progreso**.
- `maxmemory-policy allkeys-lru` → BullMQ recomienda `noeviction` (evita que Redis borre datos de jobs bajo presión de memoria en vez de rechazar la escritura).

Fix sugerido (no aplicado todavía):
```yaml
redis:
  command: redis-server --appendonly yes --maxmemory 128mb --maxmemory-policy noeviction
  volumes:
    - redis-data:/data
```

### 3. Nota sobre volúmenes Docker en este entorno (para referencia)

- `./uploads:/app/uploads` (bind mount) → los archivos de `STORAGE_TYPE=local` **sobreviven** a un `docker compose up --build` (recrear el container), porque quedan en el disco EBS de la EC2. **No sobreviven** si la instancia EC2 se reemplaza — por eso S3 es la solución real a mediano plazo (además de habilitar multi-instancia).
- RDS Postgres no usa volúmenes Docker — el almacenamiento y backups los gestiona AWS directamente.

### 4. Avisar al equipo de Flutter

Una vez confirmado el login, pasarles: `http://44.198.177.129:3000` + endpoint `/auth/login`.

---

## Notas operativas importantes

- **`deploy.sh` en la EC2 NO se actualiza solo** cuando cambiás `infrastructure/stacks/compute/template.yml`. El `UserData` de CloudFormation solo corre en el primer boot de la instancia. Cada vez que cambiás el script embebido en `compute/template.yml`, hay que:
  1. Regenerar el contenido con los valores reales ya sustituidos (secret ARNs, DB endpoint, bucket — ver ejemplos arriba).
  2. Codificarlo en base64 y escribirlo vía SSM (`echo <b64> | base64 -d > /opt/sana-ia/deploy.sh`).
  3. Correrlo (`sudo /opt/sana-ia/deploy.sh`).
- **Cambios de código de la app** (`sana-ia-backend/src/**`) sí requieren `git push` a `main` — la EC2 clona desde GitHub, no desde tu disco local.
- Para apagar/prender la EC2 y no gastar de más: `aws ec2 stop-instances --instance-ids i-05add038675565a05` / `start-instances`.
