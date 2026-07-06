# Guía de despliegue — SANA-IA (stack `sana-ia-dev`)

Estado verificado el 2026-07-06:
- Stack `sana-ia-dev`: `UPDATE_COMPLETE` (ya existe, no se crea desde cero).
- EC2: `i-05add038675565a05` (t3.micro, `running`).
- RDS: `sana-db-dev` (db.t3.micro, `available`).
- Código de resiliencia OCR/visión (Gemini→Groq→Cerebras con `supportsVision()`): ya en `origin/main` (commit `064aa90`).
- Template de Compute: ya inyecta `GROQ_API_KEY`, `GROQ_MODEL_VISION`, `CEREBRAS_*` correctamente (commit `d9fa015`).
- Pendiente: la instancia EC2 viva sigue corriendo con `STORAGE_TYPE=local` horneado en `/opt/sana-ia/deploy.sh` desde el último `UserData`.

## Por qué son dos pasos (no uno)

`STORAGE_TYPE=${StorageType}` se sustituye vía `Fn::Sub` **solo cuando CloudFormation renderiza `UserData`**. Un `sam deploy` que cambie el parámetro actualiza la definición del stack, pero **CloudFormation no re-ejecuta `UserData` en una instancia ya corriendo** (cloud-init lo corre una sola vez por instance-id). Por eso hace falta parchear la instancia viva por separado.

## Paso A — Actualizar el stack (deja bien horneado cualquier reemplazo futuro de la instancia)

```bash
cd infrastructure
sam build
sam deploy --config-env dev
```

`confirm_changeset = false` ya está en `samconfig.toml` → no se cuelga esperando `y/N` (a diferencia del intento anterior, que quedó con un changeset huérfano sin aplicar porque alguien pasó `--confirm-changeset` por CLI). No hace falta limpiar ese changeset viejo; es inofensivo y uno nuevo lo reemplaza.

## Paso B — Aplicar el fix a la instancia que YA está corriendo

```bash
aws ssm send-command \
  --instance-ids i-05add038675565a05 \
  --document-name "AWS-RunShellScript" \
  --region us-east-1 \
  --parameters commands='["sudo sed -i \"s/STORAGE_TYPE=local/STORAGE_TYPE=s3/\" /opt/sana-ia/deploy.sh","sudo /opt/sana-ia/deploy.sh"]'
```

Esto parchea el único valor desactualizado del script ya horneado y lo re-ejecuta: `git pull` (trae `064aa90`), regenera `.env` completo (Groq/Cerebras/vision ya correctos en el template) con `STORAGE_TYPE=s3`, reconstruye y reinicia el contenedor.

## Paso C — Verificar

```bash
aws ssm send-command --instance-ids i-05add038675565a05 --document-name "AWS-RunShellScript" \
  --region us-east-1 --parameters commands='["tail -n 60 /var/log/sana-deploy.log","echo ---","sudo docker ps -a"]'

# leer el resultado del comando anterior:
aws ssm get-command-invocation --command-id <COMMAND_ID> --instance-id i-05add038675565a05 --region us-east-1
```

Luego confirmar con una prueba real de OCR que el objeto de la imagen aparece en el bucket S3 (`aws s3 ls s3://<bucket>/ --recursive`).

## Apagar recursos cuando no se usan

```bash
# EC2 — conserva el disco, deja de cobrar cómputo
aws ec2 stop-instances --instance-ids i-05add038675565a05 --region us-east-1

# RDS — el que más pesa en el costo. AWS lo reinicia solo tras 7 días parado.
aws rds stop-db-instance --db-instance-identifier sana-db-dev --region us-east-1
```

Para reactivar: `aws ec2 start-instances ...` / `aws rds start-db-instance ...`.
**No usar `terminate-instances` ni borrar la RDS** salvo que se quiera reprovisionar todo desde cero — eso destruye el estado.

## Rotación de secretos (ver análisis completo en el chat)

Las API keys (Gemini/Groq/Cerebras) están sembradas desde `samconfig.toml` (gitignored) hacia Secrets Manager vía parámetros `NoEcho: true`. Para rotar una key **sin tocar CloudFormation**:

```bash
aws secretsmanager put-secret-value \
  --secret-id sana-ia/dev/gemini-api-key \
  --secret-string "<nueva-key>" \
  --region us-east-1

# luego refrescar la instancia:
aws ssm send-command --instance-ids i-05add038675565a05 --document-name "AWS-RunShellScript" \
  --region us-east-1 --parameters commands='["sudo /opt/sana-ia/deploy.sh"]'
```

El parámetro de `samconfig.toml` quedará "desactualizado" respecto al valor real — es esperado: CloudFormation solo siembra el valor inicial, Secrets Manager es la fuente de verdad después.
