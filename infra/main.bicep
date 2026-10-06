// ─────────────────────────────────────────────────────────────────────────
// Mash IT QBR Tool: the topology the app actually runs on.
//
// One Linux Consumption (Y1) Function App on Node 22 serves both the API and
// the built React SPA. Easy Auth (authsettingsV2, Entra ID) fronts every path
// except the public client self-scheduling page and its API. Data lives in
// Table Storage + Blob on the AzureWebJobsStorage account; secrets live in Key
// Vault, written by the app's system-assigned identity. Logs, storage and
// vault diagnostics go to one Log Analytics workspace.
//
// Consumption has no VNet integration, so storage and Key Vault keep public
// endpoints. Access is by account key (storage) and Entra RBAC (vault), TLS 1.2
// only, with diagnostics on both.
//
// Validate locally with:  az bicep build --file infra/main.bicep
//                         az deployment group what-if -g <rg> -f infra/main.bicep -p aadClientId=<id> aadTenantId=<id>
// ─────────────────────────────────────────────────────────────────────────

@description('Short name prefix for all resources, e.g. "mashqbr"')
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

// ── Functions (Linux Consumption) ───────────────────────────────────────────
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${namePrefix}-${env}-plan'
  location: location
  tags: tags
  sku: { name: 'Y1', tier: 'Dynamic' }
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
    siteConfig: {
      linuxFxVersion: 'Node|22'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: storageConnection }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        // The app reads KEY_VAULT_URL (must match apps/api/src/store/index.ts).
        { name: 'KEY_VAULT_URL', value: keyVault.properties.vaultUri }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        // No WEBSITE_RUN_FROM_PACKAGE: on Linux Consumption zip deploy sets it to the package URL; a literal 1 is invalid there.
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
        registration: {
          clientId: aadClientId
          openIdIssuer: '${environment().authentication.loginEndpoint}${aadTenantId}/v2.0'
        }
      }
    }
    login: { tokenStore: { enabled: true } }
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
