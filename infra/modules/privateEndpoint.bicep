// Reusable private endpoint + private DNS zone group.
@description('Private endpoint name')
param name string
param location string = resourceGroup().location
@description('Subnet resource id to place the private endpoint in')
param subnetId string
@description('Resource id of the service the PE connects to (e.g. Key Vault id)')
param privateLinkServiceId string
@description('Sub-resource group ids (e.g. ["vault"], ["blob"], ["sqlServer"])')
param groupIds array
@description('Private DNS zone resource id to register the PE record in')
param privateDnsZoneId string

resource pe 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: name
  location: location
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      {
        name: '${name}-conn'
        properties: {
          privateLinkServiceId: privateLinkServiceId
          groupIds: groupIds
        }
      }
    ]
  }
}

resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'config'
        properties: { privateDnsZoneId: privateDnsZoneId }
      }
    ]
  }
}

output id string = pe.id
