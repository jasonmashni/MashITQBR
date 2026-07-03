// ─────────────────────────────────────────────────────────────────────────
// Mash IT QBR Tool — reference infrastructure (HIPAA-aware, single MSP tenant).
//
// Topology: Static Web App (frontend) + Flex Consumption Functions (API + sync,
// VNet-integrated, system-assigned identity) + Key Vault + Azure SQL + Blob,
// all reachable only over Private Endpoints, with centralized diagnostics.
//
// Validate locally with:  az bicep build --file infra/main.bicep
//                         az deployment group what-if -g <rg> -f infra/main.bicep
// ─────────────────────────────────────────────────────────────────────────

@description('Short name prefix for all resources, e.g. "mashqbr"')
param namePrefix string = 'mashqbr'

@description('Deployment environment tag')
@allowed(['dev', 'prod'])
param env string = 'dev'

param location string = resourceGroup().location

@description('Entra ID object id of the SQL Entra admin (group recommended)')
param sqlAdminObjectId string
@description('Entra admin display name (group/user)')
param sqlAdminLogin string

var suffix = uniqueString(resourceGroup().id, env)
var saName = toLower('${namePrefix}${env}${take(suffix, 6)}')
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

// ── Network ────────────────────────────────────────────────────────────────
resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${namePrefix}-${env}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.20.0.0/16'] }
    subnets: [
      {
        name: 'functions'
        properties: {
          addressPrefix: '10.20.1.0/24'
          delegations: [{ name: 'flex', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'privateEndpoints'
        properties: {
          addressPrefix: '10.20.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

var functionsSubnetId = vnet.properties.subnets[0].id
var peSubnetId = vnet.properties.subnets[1].id

// Private DNS zones for the three data services
resource kvZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
  tags: tags
}
resource blobZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
  tags: tags
}
resource sqlZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink${az.environment().suffixes.sqlServerHostname}'
  location: 'global'
  tags: tags
}

resource kvLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: kvZone
  name: 'vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource blobLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: blobZone
  name: 'vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource sqlLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: sqlZone
  name: 'vnet-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}

// ── Key Vault (RBAC, soft-delete + purge protection, private only) ──────────
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${namePrefix}-${env}-kv'
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

// ── Storage (blob, versioned, private only) ─────────────────────────────────
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: saName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { isVersioningEnabled: true }
}

resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'app-package'
  properties: { publicAccess: 'None' }
}

resource docsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'qbr-documents'
  properties: { publicAccess: 'None' }
}

// ── Azure SQL (Entra-only auth, public access disabled) ─────────────────────
resource sql 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: '${namePrefix}-${env}-sql'
  location: location
  tags: tags
  properties: {
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: 'Group'
      login: sqlAdminLogin
      sid: sqlAdminObjectId
      tenantId: tenant().tenantId
      azureADOnlyAuthentication: true
    }
    publicNetworkAccess: 'Disabled'
    minimalTlsVersion: '1.2'
  }
}

resource sqlDb 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sql
  name: 'qbr'
  location: location
  tags: tags
  sku: { name: 'GP_S_Gen5_1', tier: 'GeneralPurpose' }
  properties: {
    autoPauseDelay: 60
    minCapacity: json('0.5')
    zoneRedundant: false
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

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: '${namePrefix}-${env}-func'
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    virtualNetworkSubnetId: functionsSubnetId
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}app-package'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: { maximumInstanceCount: 40, instanceMemoryMB: 2048 }
      runtime: { name: 'node', version: '20' }
    }
    siteConfig: {
      appSettings: [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        // The app reads KEY_VAULT_URL (must match apps/api/src/store/index.ts).
        { name: 'KEY_VAULT_URL', value: keyVault.properties.vaultUri }
        { name: 'SQL_CONNECTION_STRING', value: 'Server=tcp:${sql.properties.fullyQualifiedDomainName},1433;Database=qbr;Authentication=Active Directory Managed Identity;Encrypt=True;' }
        // Container NAME — the doc store resolves the account from AzureWebJobsStorage.
        { name: 'QBR_DOCS_CONTAINER', value: 'qbr-documents' }
      ]
    }
  }
}

// Functions identity may read secrets (Key Vault Secrets User) and use storage as Blob Data Owner.
var kvSecretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var blobDataOwner = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')

resource kvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.id, kvSecretsUser)
  scope: keyVault
  properties: { roleDefinitionId: kvSecretsUser, principalId: functionApp.identity.principalId, principalType: 'ServicePrincipal' }
}

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, blobDataOwner)
  scope: storage
  properties: { roleDefinitionId: blobDataOwner, principalId: functionApp.identity.principalId, principalType: 'ServicePrincipal' }
}

// ── Private endpoints ───────────────────────────────────────────────────────
module kvPe 'modules/privateEndpoint.bicep' = {
  name: 'kv-pe'
  params: {
    name: '${namePrefix}-${env}-kv-pe'
    location: location
    subnetId: peSubnetId
    privateLinkServiceId: keyVault.id
    groupIds: ['vault']
    privateDnsZoneId: kvZone.id
  }
}
module blobPe 'modules/privateEndpoint.bicep' = {
  name: 'blob-pe'
  params: {
    name: '${namePrefix}-${env}-blob-pe'
    location: location
    subnetId: peSubnetId
    privateLinkServiceId: storage.id
    groupIds: ['blob']
    privateDnsZoneId: blobZone.id
  }
}
module sqlPe 'modules/privateEndpoint.bicep' = {
  name: 'sql-pe'
  params: {
    name: '${namePrefix}-${env}-sql-pe'
    location: location
    subnetId: peSubnetId
    privateLinkServiceId: sql.id
    groupIds: ['sqlServer']
    privateDnsZoneId: sqlZone.id
  }
}

// ── Static Web App (Standard — enables linked "Bring Your Own" Functions) ────
resource swa 'Microsoft.Web/staticSites@2024-04-01' = {
  name: '${namePrefix}-${env}-swa'
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Standard' }
  properties: { allowConfigFileUpdates: true }
}

output functionAppName string = functionApp.name
output staticWebAppName string = swa.name
output staticWebAppHostname string = swa.properties.defaultHostname
output keyVaultUri string = keyVault.properties.vaultUri
output sqlServerFqdn string = sql.properties.fullyQualifiedDomainName
