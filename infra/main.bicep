// ─────────────────────────────────────────────────────────────────────────
// Mash IT QBR Tool: the topology the app actually runs on.
//
// One Flex Consumption (FC1) Function App on Node 24 serves both the API and
// the built React SPA. Code ships as a zip to a private blob container, read
// by the app's system-assigned identity. Easy Auth (authsettingsV2, Entra ID) fronts every path
// except the public client self-scheduling page and its API. Data lives in
// Table Storage + Blob on the AzureWebJobsStorage account; secrets live in Key
// Vault, written by the app's system-assigned identity. Logs, storage and
// vault diagnostics go to one Log Analytics workspace.
//
// Flex Consumption supports VNet integration, but this template does not
// configure it, so storage and Key Vault keep public endpoints. Access is by account key (storage) and Entra RBAC (vault), TLS 1.2
// only, with diagnostics on both.
//
// Validate locally with:  az bicep build --file infra/main.bicep
//                         az deployment group what-if -g <rg> -f infra/main.bicep -p aadClientId=<id> aadTenantId=<id>
// ─────────────────────────────────────────────────────────────────────────

@description('Short name prefix for all resources, e.g. "mashqbr" (9 chars max so storage and vault names stay under 24)')
@maxLength(9)
param namePrefix string = 'mashqbr'

@description('Deployment environment tag')
@allowed(['dev', 'prod'])
param env string = 'dev'

param location string = resourceGroup().location

@description('Application (client) id of the Entra app registration Easy Auth signs users in with')
@minLength(1)
param aadClientId string

@description('Entra tenant id that issues sign-in tokens')
param aadTenantId string = tenant().tenantId

@description('Name of the app setting that holds the Easy Auth client secret (needed for the token store that powers Create Teams meeting and server-side send). Empty disables it.')
param aadClientSecretSettingName string = ''

@description('Login parameters requested at sign-in: the Graph scopes the token store must carry for Teams scheduling and mail send.')
param loginParameters array = [
  'scope=openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite'
]

var suffix = uniqueString(resourceGroup().id, env)
var saName = toLower('${namePrefix}${env}${take(suffix, 6)}')
// Vault names are global like storage names, so they carry the same suffix (max 24 chars).
var kvName = toLower('${namePrefix}-${env}-kv-${take(suffix, 6)}')
var tags = { app: 'mashit-qbr', env: env }

// ── Observability ─────────────────────────────────────────────────────────
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-${env}-law'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 90 }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-${env}-ai'
  location: location
  tags: tags
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: law.id }
}

// ── Storage (AzureWebJobsStorage: tables, documents, Functions host) ───────
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: saName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { isVersioningEnabled: true }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource docsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'qbr-documents'
  properties: { publicAccess: 'None' }
}

// Flex Consumption deploys from a blob container rather than WEBSITE_RUN_FROM_PACKAGE.
var deploymentContainerName = 'app-package'

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: deploymentContainerName
  properties: { publicAccess: 'None' }
}

// ── Key Vault (RBAC, soft delete 90 days, purge protection) ─────────────────
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
  }
}

// ── Functions (Flex Consumption) ────────────────────────────────────────────
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${namePrefix}-${env}-plan'
  location: location
  tags: tags
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  kind: 'functionapp'
  properties: { reserved: true }
}

var storageConnection = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: '${namePrefix}-${env}-func'
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    // Flex Consumption takes the runtime and deployment source here, not from
    // linuxFxVersion, FUNCTIONS_WORKER_RUNTIME or WEBSITE_RUN_FROM_PACKAGE.
    functionAppConfig: {
      runtime: { name: 'node', version: '24' }
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: { maximumInstanceCount: 100, instanceMemoryMB: 2048 }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      // NOTE: this list REPLACES every app setting on the Function App. Settings
      // managed outside this template (ANTHROPIC_API_KEY, REPORTS_*, NARRATIVE_*,
      // RESEARCH_MODEL, QBR_*) must be re-applied after an IaC deploy; see README.
      appSettings: [
        { name: 'AzureWebJobsStorage', value: storageConnection }
        // The app reads KEY_VAULT_URL (must match apps/api/src/store/index.ts).
        { name: 'KEY_VAULT_URL', value: keyVault.properties.vaultUri }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        // Container NAME; the doc store resolves the account from AzureWebJobsStorage.
        { name: 'QBR_DOCS_CONTAINER', value: 'qbr-documents' }
      ]
    }
  }
}

// The app writes connection secrets, so it needs Secrets Officer, scoped to this vault only.
var kvSecretsOfficer = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

resource kvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.id, kvSecretsOfficer)
  scope: keyVault
  properties: { roleDefinitionId: kvSecretsOfficer, principalId: functionApp.identity.principalId, principalType: 'ServicePrincipal' }
}

// The app reads its deployment package with its identity, so it needs Storage
// Blob Data Contributor, scoped to the deployment container only.
var blobDataContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource deploymentRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(deploymentContainer.id, functionApp.id, blobDataContributor)
  scope: deploymentContainer
  properties: { roleDefinitionId: blobDataContributor, principalId: functionApp.identity.principalId, principalType: 'ServicePrincipal' }
}

// ── Easy Auth (Entra ID). Booking paths stay public: the token authorizes. ──
resource authSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: ['/book', '/book/*', '/api/book', '/api/book/*']
    }
    httpSettings: { requireHttps: true }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: union(
          {
            clientId: aadClientId
            openIdIssuer: '${environment().authentication.loginEndpoint}${aadTenantId}/v2.0'
          },
          empty(aadClientSecretSettingName) ? {} : { clientSecretSettingName: aadClientSecretSettingName }
        )
      }
    }
    login: { tokenStore: { enabled: true }, loginParameters: loginParameters }
  }
}

// ── Diagnostics → Log Analytics ─────────────────────────────────────────────
resource appDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-law'
  scope: functionApp
  properties: {
    workspaceId: law.id
    logs: [{ category: 'FunctionAppLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

resource blobDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-law'
  scope: blobService
  properties: {
    workspaceId: law.id
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
    metrics: [{ category: 'Transaction', enabled: true }]
  }
}

resource tableDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-law'
  scope: tableService
  properties: {
    workspaceId: law.id
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
    metrics: [{ category: 'Transaction', enabled: true }]
  }
}

resource kvDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-law'
  scope: keyVault
  properties: {
    workspaceId: law.id
    logs: [{ category: 'AuditEvent', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output functionAppName string = functionApp.name
output functionAppHostname string = functionApp.properties.defaultHostName
output keyVaultUri string = keyVault.properties.vaultUri
output storageAccountName string = storage.name
