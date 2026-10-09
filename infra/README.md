# Artemisa en Azure — solo el backend (~USD 10/mes)

Frontend sigue donde está (Netlify). Este directorio levanta **únicamente** el
backend de Express en Azure Container Apps, plan Consumption.

## Qué se despliega

| Recurso                             | Por qué                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `Microsoft.App/managedEnvironments` | Environment **Consumption-only**, sin Log Analytics adjunto |
| `Microsoft.App/containerApps`       | `artemisa-backend`, 0.25 vCPU / 0.5 GiB, `minReplicas: 2`   |

Nada más. Sin ACR (usa `ghcr.io`), sin Key Vault (los secretos van en el secret
store del Container App), sin App Insights, sin AKS.

## Costo esperado

Con `minReplicas: 2` y 0.25 vCPU / 0.5 GiB, **~USD 10–12/mes** en uso normal y
~USD 37 en el peor caso (100% activo). El free grant de Container Apps
(180.000 vCPU-s + 360.000 GiB-s + 2M requests por mes) está descontado.

Dos decisiones que sostienen ese número, y que **no conviene tocar**:

1. **`workloadProfiles` queda ausente en el environment, no como `[]`.**
   Ausente = plan Consumption puro. Un array vacío crea un environment de
   "workload profiles" que cobra **USD 0.10/h de gestión (~USD 73/mes)** antes
   de que corra un solo contenedor.
2. **No se adjunta `logAnalyticsConfiguration`.** Si lo adjuntás, la ingesta de
   logs se factura por GB.

Bajar `minReplicas` a `1` reduce el costo a ~USD 4–5/mes, pero perdés la
distribución entre zonas de disponibilidad.

## Requisitos

- Una cuenta de Azure con una suscripción activa.
- [`az` CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) en tu
  máquina para el armado inicial (el despliegue diario corre en GitHub
  Actions y no lo necesita).
- `jq` y `openssl` para generar los valores.

---

## Paso 1 — Resource group y región

```bash
export SUB="<tu-subscription-id>"
export RG="rg-artemisa"
export LOCATION="eastus"   # Elegí una región con zonas de disponibilidad y
                           # latencia baja para tus usuarios.

az account set --subscription "$SUB"
az group create --name "$RG" --location "$LOCATION"
```

`az account show --query id -o tsv` te devuelve `$SUB` si no lo tenés a mano.

## Paso 2 — Service principal para GitHub (OIDC, sin secretos persistentes)

El workflow se autentica con credenciales federadas: no hay que guardar una
clave de servicio en ningún lado.

```bash
export REPO="VECTORG99/Artemisa"

SP=$(az ad sp create-for-rbac \
  --name "artemisa-gh-deploy" \
  --role contributor \
  --scopes "/subscriptions/$SUB/resourceGroups/$RG" \
  --query "{clientId:clientId, tenantId:tenantId}" -o json)

export AZURE_CLIENT_ID=$(jq -r .clientId <<<"$SP")
export AZURE_TENANT_ID=$(jq -r .tenantId <<<"$SP")
export AZURE_SUBSCRIPTION_ID="$SUB"

# Una credencial federada por forma de disparo del workflow:
# push a master (release) y ejecución manual (workflow_dispatch).
for SUBJECT in \
  "repo:$REPO:ref:refs/heads/master" \
  "repo:$REPO:workflow:Deploy backend to Azure Container Apps"
do
  az ad app federated-credential create --id "$AZURE_CLIENT_ID" --parameters '{
    "name": "github-'$(echo "$SUBJECT" | md5sum | cut -c1-8)'",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "'"$SUBJECT"'",
    "audiences": ["api://AzureADTokenExchange"]
  }'
done
```

El alcance queda limitado al resource group `rg-artemisa`, no a la suscripción
entera. Es deliberado: el token de CI no puede tocar nada más.

## Paso 3 — Secretos

```bash
gh secret set AZURE_CLIENT_ID       --body "$AZURE_CLIENT_ID"
gh secret set AZURE_TENANT_ID       --body "$AZURE_TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --body "$AZURE_SUBSCRIPTION_ID"

# API key que usa el Creator UI contra el backend, y secciones protegidas.
export ARTEMISA_API_KEYS=$(openssl rand -hex 32)
gh secret set ARTEMISA_API_KEYS --body "$ARTEMISA_API_KEYS"

gh secret set METRICS_SECRET --body "$(openssl rand -hex 16)"
gh secret set BYPASS_SECRET  --body "$(openssl rand -hex 16)"

# Token de lectura de paquetes para que Container Apps pueda pull de ghcr.io.
# Fijate que expire: ver "Rotación del token de ghcr.io" más abajo.
gh secret set GHCR_TOKEN --body "<tu-PAT-con-read:packages>"
```

## Paso 4 — Variables (no secretas)

```bash
gh variable set AZURE_RESOURCE_GROUP --body "$RG"
gh variable set IMAGE_REPOSITORY     --body "vectorg99/artemisa-backend"
gh variable set PUBLIC_BASE_URL      --body "https://<lo-que-rellena-azure>"
gh variable set CORS_ALLOWED_ORIGINS --body "https://artemisa-ai.netlify.app"
```

`PUBLIC_BASE_URL` es la URL pública del propio backend. En el primer deploy no
la conocés todavía: desplegá una vez con cualquier placeholder, tomá el FQDN
del paso 5 y volvé a setear la variable con la URL real.

`CORS_ALLOWED_ORIGINS` debe coincidir **exactamente** con el origen de Netlify.
Si no coincide, el frontend recibe `403 API_CORS_FORBIDDEN` en silencio.

## Paso 5 — Primer deploy

Opción A, desde GitHub:

```bash
gh workflow run "Deploy backend to Azure Container Apps"
gh run watch
```

Opción B, manual con `az`:

```bash
az deployment group create \
  --resource-group "$RG" \
  --name artemisa-backend \
  --template-file infra/main.bicep \
  --parameters \
      imageRepository="vectorg99/artemisa-backend" \
      imageTag="<tag-inmutable>" \
      publicBaseUrl="https://<fqdn>" \
      corsAllowedOrigins="https://artemisa-ai.netlify.app" \
      artemisaApiKeys="$ARTEMISA_API_KEYS" \
      metricsSecret="$(openssl rand -hex 16)" \
      bypassSecret="$(openssl rand -hex 16)" \
      ghcrUsername="VECTORG99" \
      ghcrToken="<tu-PAT>"
```

## Paso 6 — Verificar

```bash
FQDN=$(az containerapp show -g "$RG" -n artemisa-backend \
  --query properties.configuration.ingress.fqdn -o tsv)

curl -i "https://$FQDN/api/health"        # 200
curl -i "https://$FQDN/api/health/ready"  # 200
curl -i "https://$FQDN/api/health/live"   # 200

# La protección de auth funciona: sin API key debe dar 401.
curl -i "https://$FQDN/api/v1/creator/catalog" -H "X-API-Key: incorrecta"
```

El workflow ya hace el health gate solo: si `/api/health` no contesta 200 en
5 minutos, el job falla y revierte a la imagen anterior. No podés terminar con
un deploy roto marcado como exitoso.

## Paso 7 — Apuntar el frontend

En Netlify, la variable de build:

```
NEXT_PUBLIC_API_URL=https://<fqdn>
```

`NEXT_PUBLIC_API_URL` se hornea en el bundle en tiempo de build, así que hay
que **reconstruir** el frontend, no solo cambiar la variable. Después verificar
que el Creator funcione de punta a punta.

---

## Operación del día a día

### Escalar

```bash
# Más réplicas ante tráfico
az containerapp update -g "$RG" -n artemisa-backend \
  --min-replicas 2 --max-replicas 10

# Presupuesto ajustado: una sola réplica (pierde multi-zona)
az containerapp update -g "$RG" -n artemisa-backend --min-replicas 1
```

### Rollback

Container Apps conserva el historial de revisiones aunque
`activeRevisionsMode` sea `Single`.

```bash
az containerapp revision list -g "$RG" -n artemisa-backend -o table

# Volver a una imagen anterior
az containerapp update -g "$RG" -n artemisa-backend \
  --image ghcr.io/vectorg99/artemisa-backend:<tag-anterior>
```

El workflow ya revierte automáticamente si el health gate falla. El rollback
manual es para cuando el problema aparece más tarde.

### Logs y estado

```bash
az containerapp logs show -g "$RG" -n artemisa-backend --follow
az containerapp replica list -g "$RG" -n artemisa-backend -o table
az containerapp revision list -g "$RG" -n artemisa-backend -o table
```

### Rotación del token de ghcr.io

Container Apps hace pull solo cuando necesita una réplica nueva (arranque,
scale-out, nuevo deploy). Un token expirado no corta las réplicas corriendo,
pero **impide escalar y desplegar**. Un PAT clásico puede no expirar; si usás
tokens de acceso fine-grained, caduca a lo sumo a un año. Rotá el secret de
GitHub antes de que venza.

### Monitoreo de costo

Cost Management → Cost analysis, filtro por resource group `rg-artemisa`.
Esperá ~USD 10–12/mes. Si salta a ~USD 80, lo más probable es que alguien haya
agregado `workloadProfiles` al environment o un perfil Dedicated.

Para confirmar que el environment sigue Consumption-only:

```bash
az containerapp env show -g "$RG" -n artemisa-env \
  --query "{workloadProfiles:workloadProfiles, la:properties.appLogsConfiguration}" -o json
```

Debe devolver `workloadProfiles` en `null` y sin configuración de logs.

### Alertas

```bash
az monitor metrics alert create \
  --name "artemisa-5xx" \
  --resource-group "$RG" \
  --scopes "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/containerApps/artemisa-backend" \
  --condition "count requests 5xx > 5 avg 5m" \
  --description "Cinco o más respuestas 5xx en 5 minutos"
```

---

## Desmontar

```bash
az group delete --name "$RG" --yes --no-wait
```

Borra el resource group completo. Las imágenes en `ghcr.io` y los secretos de
GitHub quedan intactos.

---

## Notas de implementación

- **`TRUST_PROXY=1` es obligatorio, no opcional.** Container Apps termina el
  TLS, así que sin esta variable Express ve la IP del proxy en lugar de la del
  cliente. Como el rate limiting keyea por IP, todas las peticiones parecen
  venir de un mismo origen y después de `RATE_LIMIT_GLOBAL` (100/min) el
  servidor **bloquea a todos tus usuarios reales**. Es la forma más rápida de
  autoinfligirse una caída.
- **`PUBLIC_BASE_URL` también es obligatorio en producción.** Sin él, el
  origen que el backend anuncia a los agentes se toma de los headers de la
  petición, que controla el cliente: un header forjado puede apuntar a otro
  servidor.
- Los probes apuntan a `/health/live` y `/health/ready`, que ya existen en
  `src/routes/health.ts`. Cablearlos es lo que permite que Container Apps
  reinicie un proceso colgado por su cuenta.
- `agent-creator/` **no se despliega**. Está marcado como legacy; el Creator
  activo es `frontend/agents/new`.
- La imagen se construye con `docker/Dockerfile.backend` desde la raíz del
  repo, igual que en `docker-compose.yml`.
- El tag de la imagen es el SHA corto del commit: inmutable, así un rollback
  siempre apunta al contenido que nombraba.
