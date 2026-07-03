# SANA-IA Deploy Checklist

Pasos faltantes para completar el deploy. Tu usuario IAM (`sana-dep`) está configurado y logueado en AWS CLI.

---

## PASO 1: Obtener datos de tu cuenta AWS

Necesitás 4 valores de tu consola AWS. Abrí en tu navegador:

### 1.1 VPC ID
- Consola AWS → VPC → **VPCs**
- Buscá tu VPC default (generalmente dice "default" en la columna State)
- Copiá el **VPC ID** (formato: `vpc-xxx...`)

### 1.2 Subnet para EC2 (Compute Subnet)
- VPC → **Subnets**
- Filtrá por tu VPC
- Elegí UNA que sea **pública** (véase si tiene "Internet Gateway" en la ruta)
- Copiá el **Subnet ID** (formato: `subnet-xxx...`)

### 1.3 Subnets para RDS (2 mínimo, en AZs diferentes)
- Misma pantalla de Subnets
- Elegí 2 subnets que estén en **diferentes Availability Zones** (columna "AZ")
- Copiá ambos **Subnet IDs** (ej: `subnet-aaa,subnet-bbb`)

### 1.4 CIDR para API (opcional)
- **Dejá en blanco o confirmá `0.0.0.0/0`** (acceso público)
- Este valor lo va a sugerir SAM por defecto (es lo que configuramos)

---

## PASO 2: Correr `sam deploy --guided`

En PowerShell:

```powershell
cd C:\Users\ajlopez\Documents\sitespr\Sana-IA-\infrastructure
sam deploy --guided
```

SAM te va a hacer preguntas. Respondé así:

| Pregunta | Respuesta |
|----------|-----------|
| Stack name | `sana-ia-dev` |
| Region | `us-east-1` |
| Parameter Env | `dev` |
| Parameter VpcId | El VPC ID del Paso 1.1 |
| Parameter ComputeSubnetId | El Subnet ID del Paso 1.2 |
| Parameter DbSubnetIds | Los 2 Subnet IDs del Paso 1.3 (separados por coma) |
| Parameter BackendCidr | Dejá vacío (presioná Enter) — usará el default `0.0.0.0/0` |
| Other parámetros | Presioná Enter para todos (usan defaults) |
| Confirm changeset | `y` (yes) |
| Allow SAM to create IAM roles | `y` (yes) |
| Save arguments | `y` (yes) → crea `samconfig.toml` |

**El deploy tarda ~5-8 minutos.** RDS es lo que más tarda.

### Outputs esperados al terminar:
```
Outputs:
  BackendUrl: http://XX.XX.XX.XX:3000
  InstanceId: i-xxxxx
  DbEndpoint: sana-db-dev.xxxxx.us-east-1.rds.amazonaws.com
  LabsBucketName: sana-ia-labs-dev-xxxxx
  GeminiApiKeySecretArn: arn:aws:secretsmanager:...
  GitHubPatSecretArn: arn:aws:secretsmanager:...
```

**Guardá estos valores — los usarás después.**

---

## PASO 3: Completar los Secretos (IMPORTANTE)

Los secretos de Gemini y GitHub se crean con placeholders. Necesitás rellenarlos:

### 3.1 Gemini API Key
En PowerShell:

```powershell
aws secretsmanager put-secret-value `
  --secret-id "<GeminiApiKeySecretArn del output del Paso 2>" `
  --secret-string "tu-gemini-api-key-aqui"
```

Reemplazá `tu-gemini-api-key-aqui` con tu API key real de Google Gemini.

### 3.2 GitHub Personal Access Token
```powershell
aws secretsmanager put-secret-value `
  --secret-id "<GitHubPatSecretArn del output del Paso 2>" `
  --secret-string "tu-github-pat-aqui"
```

Reemplazá `tu-github-pat-aqui` con tu PAT (con permisos `Contents: Read-only` sobre `armlpez/Sana-IA-`).

---

## PASO 4: Correr el Deploy Real en la EC2

Entrá a la instancia via SSM (sin SSH):

```powershell
aws ssm start-session --target "<InstanceId del output del Paso 2>"
```

Dentro de la sesión:

```bash
sudo /opt/sana-ia/deploy.sh
```

Esto:
1. Clona el repo privado usando el GitHub PAT.
2. Arma el `.env` con los secretos reales.
3. Levanta `docker compose --profile cloud up -d --build` (Nest + Redis).

**El primer intento puede tardar 2-3 minutos** (descarga imagen Docker, npm install, build).

### Verificaciones:
```bash
sudo docker ps
# Deberías ver 2 containers: sana-backend y sana-redis

curl localhost:3000
# Deberías recibir algo de HTML (la página raíz de Nest)
```

Desde tu máquina:
```powershell
curl "http://<BackendUrl del Paso 2>"
```

---

## PASO 5: Actualizar Código (en el futuro)

Cada vez que hagás `git push` a `main`:

```powershell
aws ssm start-session --target "<InstanceId>"
```

```bash
sudo /opt/sana-ia/deploy.sh
```

El script es idempotente: si el repo ya existe, hace `git pull` + rebuild.

---

## PASO 6: Cambiar a S3 (cuando esté listo)

Cuando el adapter S3 del storage esté validado:

```powershell
cd C:\Users\ajlopez\Documents\sitespr\Sana-IA-\infrastructure
sam deploy --parameter-overrides StorageType=s3
```

Volvé a correr en la EC2:
```bash
sudo /opt/sana-ia/deploy.sh
```

---

## PASO 7: Apagar / Prender (sin gastar)

De noche / fin de semana:
```powershell
aws ec2 stop-instances --instance-ids "<InstanceId>"
```

Al retomar:
```powershell
aws ec2 start-instances --instance-ids "<InstanceId>"
```

Espera ~2 min a que arranque, luego probá la URL de nuevo.

---

## Troubleshooting

### Error: "Unable to parse config file"
→ Corremos esto en PowerShell: `aws sts get-caller-identity` para verificar que las credenciales están bien.

### Error en EC2: "git clone: command not found"
→ Falta git en la EC2. En la sesión SSM: `sudo dnf install -y git`

### Error: "docker: command not found"
→ El UserData no terminó. Espera 2 min y probá de nuevo. Si persiste, revisá `/var/log/sana-userdata.log`.

### API lentitud / timeouts
→ Probablemente la EC2 está procesando OCR. Revisá con `sudo docker logs sana-backend`.

---

## Notas finales

- **Backend URL**: Usá `http://<IP>:3000` (sin HTTPS por ahora — es lab).
- **Autenticación**: El Flutter app hace login en `/auth/login` y obtiene JWT.
- **Todos los secrets son auto-generados excepto Gemini + GitHub PAT** (los completás vos).
- **El bucket S3 limpia imágenes cada 7 días** (lifecycle rule automática).

---

**¿Problemas?** Revisá:
1. `aws sts get-caller-identity` → confirma que estás logueado como `sana-dep`.
2. `/var/log/sana-deploy.log` en la EC2 (via SSM).
3. `aws secretsmanager list-secrets` → confirma que los 5 secretos existen.
