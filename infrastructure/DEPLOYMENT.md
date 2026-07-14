# Guía de despliegue — SANA-IA (stack `sana-ia-dev`)

> ⚠️ **El `EC2 InstanceId` de abajo queda desactualizado en CUANTO corra el próximo `sam deploy`.** No lo copies a un script ni lo hardcodees en nada nuevo — usá siempre el lookup dinámico de la sección "Cómo encontrar la instancia actual" antes de apuntar un comando SSM a un ID. Este documento ya quedó stale dos veces por esto mismo (`i-05add038675565a05` → `i-01823b53ca31eb30f` → `i-00d36f35228cd4896`).

Estado verificado el 2026-07-14:
- Stack `sana-ia-dev`: `UPDATE_COMPLETE`.
- EC2: `i-00d36f35228cd4896` (t3.micro, `running`) — **reemplazada hoy por un `sam deploy`** (ver incidente abajo).
- RDS: `sana-db-dev` (db.t3.micro, `available`). `pgvector 0.7.3` disponible (no instalada).
- Gemini: los 3 tiers (`GEMINI_MODEL_COLLECTING/ANALYZING/COMPLETED`) pasaron de `gemini-2.5-flash(-lite)` a `gemini-3.1-flash-lite` — el modelo viejo agotó su cuota diaria (20 RPD) mientras operaba como fallback de Bedrock; el nuevo tiene 500 RPD y mismos límites de contexto/JSON mode.

## ⚠️ Incidente 2026-07-14: `sam deploy` reemplazó la instancia (no solo actualizó el stack)

**La suposición de la sección de abajo ("CloudFormation no re-ejecuta UserData en una instancia ya corriendo") es cierta pero INCOMPLETA — no dice que `sam deploy` puede REEMPLAZAR la instancia entera cuando cambia `UserData`, y en este stack lo hace.**

Pasó así: se editó `template.yml` (cambio de modelo Gemini), se corrió `sam deploy` esperando que solo actualizara la definición del stack para "el día que la instancia se reemplace". En cambio, la instancia vieja (`i-01823b53ca31eb30f`) pasó a `terminated` de inmediato y nació una nueva (`i-00d36f35228cd4896`) — con la misma IP pública porque hay una Elastic IP que se reasocia sola, lo cual **enmascara el reemplazo** si solo mirás si el `curl` al endpoint sigue respondiendo.

**Consecuencia práctica**: cualquier parche manual hecho por SSM directamente al `/opt/sana-ia/deploy.sh` de una instancia viva (como el fix de `STORAGE_TYPE` documentado abajo, Paso B) **se pierde por completo** si después corrés un `sam deploy` que toque `UserData` — la instancia nueva solo hereda lo que esté en `template.yml` en el momento del deploy, nunca lo que se parcheó a mano en la instancia anterior.

**Orden correcto de ahora en más**:
1. Editar `template.yml` primero.
2. Correr `sam deploy` — asumí que esto puede reemplazar la instancia. Verificá con `aws ec2 describe-instances` (ver abajo) si cambió el `InstanceId`.
3. **Solo si la instancia NO se reemplazó** (mismo `InstanceId` que antes), recién ahí hace falta el parche SSM manual (Paso B) para aplicar el cambio a la instancia viva. Si sí se reemplazó, la instancia nueva ya nació con el valor correcto — Paso B sería redundante.

## Checklist post-deploy verificado 2026-07-14 (instancia `i-00d36f35228cd4896`)

Tras el incidente de reemplazo de instancia, se verificó en vivo (no asumido) que nada se haya perdido:

| Chequeo | Cómo se verificó | Resultado |
|---|---|---|
| `STORAGE_TYPE` | `docker exec sana-backend env \| grep STORAGE_TYPE` | `s3` ✅ — viene de `StorageType=s3` en `parameter_overrides` de `samconfig.toml` (fuente estable, no depende de parches manuales) |
| Cadena de LLM (`LLM_PRIMARY_PROVIDER`, `LLM_FALLBACK_CHAIN`, `BEDROCK_*`) | `docker exec sana-backend env \| grep BEDROCK_` | Presente y correcto: `bedrock` primario, fallback `gemini,groq,cerebras`, modelos `gpt-oss-20b`/`gpt-oss-120b`/`qwen3-vl` |
| Bedrock funciona de verdad (no solo configurado) | Llamada real a `POST /v1/ai/chat` + `docker logs sana-backend \| grep -i bedrock` | `[ResilientLlmService] Trying primary LLM: bedrock` sin línea de fallback posterior → respondió Bedrock directo, sin caer a Gemini |
| Modelo Gemini de fallback | `docker exec sana-backend env \| grep GEMINI_MODEL` | `gemini-3.1-flash-lite` en los 3 tiers ✅ |
| `samconfig.toml` no filtra secretos al repo | `git check-ignore` + `git log --all -- infrastructure/samconfig.toml` | Ignorado por `.gitignore:6`, nunca en el historial |

`samconfig.toml` (gitignored) es la fuente de verdad real de los parámetros de despliegue — más confiable que los `Default:` de `template.yml`, que solo aplican si `parameter_overrides` no los pisa.

## Cómo encontrar la instancia actual (no confíes en un ID de este documento)

```bash
aws ec2 describe-instances --region us-east-1 \
  --filters "Name=tag:Name,Values=sana-backend-dev" "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].{Id:InstanceId,LaunchTime:LaunchTime,PublicIp:PublicIpAddress}" \
  --output table
```

## Por qué son dos pasos (no uno) — y por qué a veces son cero

`STORAGE_TYPE=${StorageType}` se sustituye vía `Fn::Sub` **solo cuando CloudFormation renderiza `UserData`**. El razonamiento original era: un `sam deploy` que cambie el parámetro actualiza la definición del stack, pero no toca la instancia corriendo, así que hace falta parchear la instancia viva por separado (Paso B). **Ese razonamiento asume que la instancia sobrevive al `sam deploy` — verificalo, no lo asumas** (ver incidente arriba). Si la instancia se reemplazó, ya nació con el valor nuevo horneado y el Paso B no hace falta.

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
  --instance-ids <INSTANCE_ID> \
  --document-name "AWS-RunShellScript" \
  --region us-east-1 \
  --parameters commands='["sudo sed -i \"s/STORAGE_TYPE=local/STORAGE_TYPE=s3/\" /opt/sana-ia/deploy.sh","sudo /opt/sana-ia/deploy.sh"]'
```

Esto parchea el único valor desactualizado del script ya horneado y lo re-ejecuta: `git pull` (trae `064aa90`), regenera `.env` completo (Groq/Cerebras/vision ya correctos en el template) con `STORAGE_TYPE=s3`, reconstruye y reinicia el contenedor.

## Paso C — Verificar

```bash
aws ssm send-command --instance-ids <INSTANCE_ID> --document-name "AWS-RunShellScript" \
  --region us-east-1 --parameters commands='["tail -n 60 /var/log/sana-deploy.log","echo ---","sudo docker ps -a"]'

# leer el resultado del comando anterior:
aws ssm get-command-invocation --command-id <COMMAND_ID> --instance-id <INSTANCE_ID> --region us-east-1
```

Luego confirmar con una prueba real de OCR que el objeto de la imagen aparece en el bucket S3 (`aws s3 ls s3://<bucket>/ --recursive`).

## Apagar recursos cuando no se usan

```bash
# EC2 — conserva el disco, deja de cobrar cómputo
aws ec2 stop-instances --instance-ids <INSTANCE_ID> --region us-east-1

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
aws ssm send-command --instance-ids <INSTANCE_ID> --document-name "AWS-RunShellScript" \
  --region us-east-1 --parameters commands='["sudo /opt/sana-ia/deploy.sh"]'
```

El parámetro de `samconfig.toml` quedará "desactualizado" respecto al valor real — es esperado: CloudFormation solo siembra el valor inicial, Secrets Manager es la fuente de verdad después.
