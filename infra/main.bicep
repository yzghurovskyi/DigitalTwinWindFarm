@description('Deployment location')
param location string = resourceGroup().location

@description('Azure Digital Twins instance name')
param adtName string

@description('IoT Hub name')
param iotHubName string

@description('Storage account name (shared by Function App)')
param storageAccountName string

@description('Log Analytics workspace name')
param lawName string

@description('Function App name for IoT Hub telemetry processor')
param functionAppName string

@description('Backend API web app name (Express + WebSocket server)')
param backendAppName string

@description('Azure Static Web Apps name for the realvirtual-WEB frontend')
param staticWebAppName string

// ── Azure Digital Twins ────────────────────────────────────────────────────

resource adt 'Microsoft.DigitalTwins/digitalTwinsInstances@2023-01-31' = {
  name: adtName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

// ── IoT Hub ────────────────────────────────────────────────────────────────

resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' = {
  name: iotHubName
  location: location
  sku: {
    name: 'S1'
    capacity: 1
  }
  properties: {
    publicNetworkAccess: 'Enabled'
    features: 'None'
  }
}

// ── Storage Account ────────────────────────────────────────────────────────

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// ── Log Analytics Workspace ────────────────────────────────────────────────

resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: lawName
  location: location
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

// ── App Service Plan (Consumption) ────────────────────────────────────────

resource hostingPlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: '${functionAppName}-plan'
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: {
    reserved: true  // required for Linux hosting plans
  }
}

// ── Function App (IoT Hub → ADT processor) ────────────────────────────────

resource functionApp 'Microsoft.Web/sites@2023-01-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: hostingPlan.id
    siteConfig: {
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value}'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'APPINSIGHTS_INSTRUMENTATIONKEY'
          value: appInsights.properties.InstrumentationKey
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
        {
          name: 'ADT_URL'
          // Populated post-deployment — use the output value from this template
          value: 'https://${adt.properties.hostName}'
        }
        {
          name: 'IOT_HUB_CONNECTION'
          // EventHub-compatible connection string — fill in after deployment:
          // az iot hub connection-string show --hub-name <name> --default-eventhub
          value: ''
        }
        {
          name: 'IOT_HUB_EVENTHUB_NAME'
          // Event Hub-compatible entity name (NOT 'messages/events')
          // az iot hub show --name <name> --query properties.eventHubEndpoints.events.path -o tsv
          value: ''
        }
        {
          name: 'BACKEND_INGEST_URL'
          value: 'https://${backendApp.properties.defaultHostName}/ingest'
        }
      ]
      linuxFxVersion: 'Node|22'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
    }
    httpsOnly: true
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${functionAppName}-ai'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
  }
}

// ── Backend App Service Plan (Linux B1 – required for WebSocket support) ──

resource backendPlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: '${backendAppName}-plan'
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

// ── Backend Web App (Node.js 20 on Linux) ─────────────────────────────────

resource backendApp 'Microsoft.Web/sites@2023-01-01' = {
  name: backendAppName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: backendPlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appSettings: [
        {
          name: 'ADT_URL'
          value: 'https://${adt.properties.hostName}'
        }
        {
          name: 'PORT'
          value: '8080'
        }
        {
          name: 'WEBSITES_PORT'
          value: '8080'
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'APPINSIGHTS_INSTRUMENTATIONKEY'
          value: appInsights.properties.InstrumentationKey
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
      ]
      webSocketsEnabled: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
    }
    httpsOnly: true
  }
}

// ── Role: Function App managed identity → ADT Data Owner ──────────────────

var adtDataOwnerRoleId = 'bcd981a7-7f74-457b-83e1-cceb9e632ffe'

resource adtRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(adt.id, functionApp.id, adtDataOwnerRoleId)
  scope: adt
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', adtDataOwnerRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Role: Backend managed identity → ADT Data Owner ───────────────────────

resource backendAdtRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(adt.id, backendApp.id, adtDataOwnerRoleId)
  scope: adt
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', adtDataOwnerRoleId)
    principalId: backendApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Static Web App (realvirtual-WEB frontend) ──────────────────────────────

resource staticWebApp 'Microsoft.Web/staticSites@2023-01-01' = {
  name: staticWebAppName
  // Static Web Apps are only available in a subset of regions.
  // Default to westus2 if the target region is unsupported.
  location: contains(['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'], location)
    ? location
    : 'westeurope'
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

// ── Outputs ────────────────────────────────────────────────────────────────

output adtHostName string = adt.properties.hostName
output iotHubHostName string = iotHub.properties.hostName
output functionAppName string = functionApp.name
output backendHostName string = backendApp.properties.defaultHostName
output staticWebAppHostName string = staticWebApp.properties.defaultHostname
@description('Deploy token for the Static Web App — treat as a secret.')
@secure()
output staticWebAppDeployToken string = staticWebApp.listSecrets().properties.apiKey
