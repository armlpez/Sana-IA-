# SANA-IA — Infrastructure (AWS SAM)

EC2 + RDS + S3 para el entorno de pruebas. Sin API Gateway, sin Lambda: la EC2 corre
Nest + Redis en Docker; RDS es el Postgres gestionado; S3 guarda las imágenes de labs.

## Prerequisitos

- AWS CLI configurado (`aws configure`) con un usuario IAM que tenga la política
  administrada **`PowerUserAccess`** (ver "Permisos del usuario deployer" abajo).
- SAM CLI instalado (`sam --version`).
- Tu IP pública: `curl https://checkip.amazonaws.com` (o buscar "cual es mi ip" en el navegador). Necesitás el formato CIDR /32, ej. `203.0.113.5/32`.
- Un **GitHub Personal Access Token** (fine-grained, solo permiso `Contents: Read-only` sobre `armlpez/Sana-IA-`) — el repo es privado y la EC2 lo necesita para clonar.
- Tu API key de Gemini.

## Permisos del usuario deployer

El usuario IAM que corre `sam deploy` (ej. `sana-dep`) necesita **dos piezas**, no una sola:

| Pieza | Qué cubre | Por qué |
|---|---|---|
| Política administrada `PowerUserAccess` | EC2, RDS, S3, Secrets Manager, CloudFormation, SSM | Cubre todos los servicios que estos 6 templates usan, sin enumerar cada acción a mano |
| [`bootstrap/deployer-iam-policy.json`](./bootstrap/deployer-iam-policy.json) (inline, en este repo) | Crear/gestionar **únicamente** `sana-backend-role-*` y `sana-backend-profile-*` | `PowerUserAccess` excluye a propósito todo `iam:*` — es "poder de usuario", no admin. Como `stacks/iam/template.yml` crea un Role + Instance Profile, hace falta este permiso puntual además |

Sin la segunda pieza, el deploy falla en el stack `SanaIam` con `AccessDenied: iam:GetRole`
(o `CreateRole`). El scope de `deployer-iam-policy.json` está limitado a los nombres de
recursos de este proyecto — no da acceso a IAM en general.

### Por qué esto no puede ir dentro del stack de SAM

Es un problema circular: para que `sana-dep` pudiera crear ese permiso vía CloudFormation,
ya necesitaría el permiso de `iam:CreatePolicy` — que es justamente lo que ese recurso le
otorgaría. Ninguna herramienta de IaC (Terraform, CDK, SAM) puede auto-otorgarse permisos
a sí misma en la misma corrida; por eso CDK tiene `cdk bootstrap` como paso separado, y por
qué esto es un paso manual, único por cuenta, ejecutado por alguien con más privilegio
(el usuario root o un admin) — nunca por `sana-dep` mismo.

### Aplicar el permiso (una sola vez, con el usuario root/admin)

```bash
# 1. Reemplazá <ACCOUNT_ID> en el archivo por tu Account ID real
sed -i "s/<ACCOUNT_ID>/$(aws sts get-caller-identity --query Account --output text)/g" \
  infrastructure/bootstrap/deployer-iam-policy.json

# 2. Aplicá la política inline al usuario deployer (requiere credenciales de un admin/root)
aws iam put-user-policy \
  --user-name sana-dep \
  --policy-name SanaBackendRoleManagement \
  --policy-document file://infrastructure/bootstrap/deployer-iam-policy.json

# 3. Revertí el archivo a <ACCOUNT_ID> antes de commitear (no versionamos el Account ID real)
git checkout infrastructure/bootstrap/deployer-iam-policy.json
```

Verificación rápida (con las credenciales de `sana-dep`): `aws iam get-role --role-name
sana-backend-role-dev` debe devolver `NoSuchEntity` (el rol no existe todavía, pero el
permiso para consultarlo sí) en vez de `AccessDenied`.

## 1. Deploy inicial

```bash
cd infrastructure
sam build
sam deploy --guided
```

Durante el guiado, SAM te va a mostrar tus VPCs/subnets reales en una lista — elegí la
VPC default de tu cuenta y al menos 2 subnets en AZs distintas para `DbSubnetIds`
(una de esas mismas puede ser `ComputeSubnetId`). Cuando pregunte "Save arguments to
configuration file?", respondé sí — queda en `samconfig.toml` (gitignored, no se sube).

Parámetros que te va a pedir:
- `Env`: dev
- `VpcId`: tu VPC default
- `ComputeSubnetId`: una subnet pública
- `DbSubnetIds`: 2+ subnets en AZs distintas
- `BackendCidr`: dejá el default `0.0.0.0/0` (público), o restringí a tu IP en formato /32
- `StorageType`: dejalo en `local` para este primer deploy

El deploy tarda ~5-8 minutos (RDS es lo más lento). Al terminar, SAM imprime los
`Outputs`: `BackendUrl`, `InstanceId`, `DbEndpoint`, `LabsBucketName`,
`GeminiApiKeySecretArn`, `GitHubPatSecretArn`.

## 2. Completar los secretos (paso obligatorio, una sola vez)

Los secretos de Gemini y GitHub se crean con un placeholder — CloudFormation no puede
inventar un API key externo. La EC2 ya intentó arrancar y **va a fallar la primera
vez** (esperado: revisa `/var/log/sana-deploy.log` si querés confirmarlo). Rellená
los valores reales:

```bash
aws secretsmanager put-secret-value \
  --secret-id "<GeminiApiKeySecretArn del output>" \
  --secret-string "TU_GEMINI_API_KEY"

aws secretsmanager put-secret-value \
  --secret-id "<GitHubPatSecretArn del output>" \
  --secret-string "TU_GITHUB_PAT"
```

## 3. Correr el deploy real (via SSM, sin SSH)

```bash
aws ssm start-session --target "<InstanceId del output>"
```

Dentro de la sesión:

```bash
sudo /opt/sana-ia/deploy.sh
```

Esto clona el repo, arma el `.env` con los secretos reales, y levanta
`docker compose --profile cloud up -d --build` (Nest + Redis). Confirmá:

```bash
sudo docker ps
curl localhost:3000
```

Desde tu máquina: `curl <BackendUrl del output>` (o apuntá tu Flutter ahí).

## 4. Actualizar código (cada vez que hagas push)

```bash
aws ssm start-session --target "<InstanceId>"
sudo /opt/sana-ia/deploy.sh
```

`deploy.sh` es idempotente: si el repo ya existe, hace `git fetch` + `reset --hard`
sobre la rama configurada y reconstruye los contenedores.

## 5. Pasar a S3 (cuando el adapter esté validado)

El bucket y el permiso IAM ya existen desde el primer deploy. Solo hace falta:

```bash
sam deploy --parameter-overrides StorageType=s3
```

Y volver a correr `sudo /opt/sana-ia/deploy.sh` en la instancia (regenera el `.env`
con `STORAGE_TYPE=s3` y el nombre del bucket).

## Apagar / prender para no gastar de más

```bash
aws ec2 stop-instances  --instance-ids <InstanceId>   # de noche / fin de semana
aws ec2 start-instances --instance-ids <InstanceId>   # al retomar pruebas
```

RDS no tiene freno manual persistente igual de simple (se auto-reinicia a los 7 días
si lo parás con `aws rds stop-db-instance`) — para pruebas cortas, dejalo prendido;
está cubierto por el free tier de 750h/mes igual que la EC2.

## Destruir todo

```bash
sam delete --stack-name sana-ia-dev
```

Borra EC2, RDS, S3 (vacío — si tiene objetos, vaciá el bucket antes), secretos e IAM.
Con `DeletionPolicy: Delete` en RDS/S3 (entorno de prueba), no quedan snapshots
huérfanos cobrando de más.

## Notas de diseño

- **Sin SSH**: acceso solo vía SSM Session Manager (`aws ssm start-session`). El
  Security Group no abre el puerto 22.
- **Sin credenciales AWS en código**: la EC2 usa su Instance Role para leer Secrets
  Manager y escribir en S3. Los secretos nunca están en el template ni en
  `samconfig.toml`.
- **`labs/` como prefix**: el bucket S3 expira objetos con prefix `labs/` a los 7
  días — coincide con el key que genera `ocr.controller.ts`
  (`labs/<uuid>.<ext>`), así que el lifecycle rule aplica directo sin ajustes.
