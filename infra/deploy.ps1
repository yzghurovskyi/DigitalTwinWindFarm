param(
  [Parameter(Mandatory = $true)][string]$SubscriptionId,
  [Parameter(Mandatory = $true)][string]$ResourceGroupName,
  [Parameter(Mandatory = $false)][string]$Location = "westeurope",
  [Parameter(Mandatory = $false)][string]$ParametersFile = ".\parameters.example.json"
)

$ErrorActionPreference = "Stop"

# Warn when the caller relies on the example parameters file so that
# resource name collisions with other lab deployments are visible.
if ($ParametersFile -eq ".\parameters.example.json") {
  Write-Warning "Using example parameter values. Copy parameters.example.json to parameters.json, edit resource names, and pass -ParametersFile .\parameters.json for a unique deployment."
}

Write-Host "Selecting subscription: $SubscriptionId"
az account set --subscription $SubscriptionId | Out-Null

if (-not (az group exists --name $ResourceGroupName | ConvertFrom-Json)) {
  Write-Host "Creating resource group: $ResourceGroupName"
  az group create --name $ResourceGroupName --location $Location | Out-Null
}

Write-Host "Deploying infrastructure..."
$output = az deployment group create `
  --resource-group $ResourceGroupName `
  --template-file ".\main.bicep" `
  --parameters "@$ParametersFile" `
  --output json | ConvertFrom-Json

Write-Host "Deployment completed."
Write-Host ""
Write-Host "=== Outputs ==="
Write-Host "ADT hostname      : $($output.properties.outputs.adtHostName.value)"
Write-Host "IoT Hub           : $($output.properties.outputs.iotHubHostName.value)"
Write-Host "Function App      : $($output.properties.outputs.functionAppName.value)"
Write-Host "Backend App       : $($output.properties.outputs.backendHostName.value)"
Write-Host "Static Web App    : $($output.properties.outputs.staticWebAppHostName.value)"
Write-Host ""
Write-Host "=== Next steps ==="
Write-Host ""
Write-Host "1. Wire up IoT Hub EventHub connection string in the Function App:"
Write-Host "   `$conn = az iot hub connection-string show --hub-name $($output.properties.outputs.iotHubHostName.value.Split('.')[0]) --policy-name service --query connectionString -o tsv"
Write-Host "   az functionapp config appsettings set --name $($output.properties.outputs.functionAppName.value) --resource-group $ResourceGroupName --settings `"IOT_HUB_CONNECTION=`$conn`""
Write-Host ""
Write-Host "2. Upload DTDL models and seed the twin graph:"
Write-Host "   `$env:ADT_URL = 'https://$($output.properties.outputs.adtHostName.value)'"
Write-Host "   cd ..\seed && npm install"
Write-Host "   node upload-models.mjs"
Write-Host "   node seed-twins.mjs"
Write-Host ""
Write-Host "3. Deploy the Azure Function:"
Write-Host "   cd ..\functions && npm install"
Write-Host "   func azure functionapp publish $($output.properties.outputs.functionAppName.value)"
Write-Host ""
Write-Host "4. Deploy the backend to App Service:"
Write-Host "   cd ..\backend"
Write-Host "   az webapp up --name $($output.properties.outputs.backendHostName.value.Split('.')[0]) --resource-group $ResourceGroupName --runtime 'NODE:20-lts'"
Write-Host ""
Write-Host "5. Build and deploy the realvirtual-WEB frontend:"
Write-Host "   cd ..\realvirtual-WEB && npm install && npm run build"
Write-Host "   `$token = az staticwebapp secrets list --name $($output.properties.outputs.staticWebAppHostName.value.Split('.')[0]) --query 'properties.apiKey' -o tsv"
Write-Host "   npx @azure/static-web-apps-cli deploy ./dist --deployment-token `$token"
Write-Host ""
Write-Host "6. Register a turbine device in IoT Hub and copy its connection string to simulator/.env:"
Write-Host "   az iot hub device-identity create --hub-name $($output.properties.outputs.iotHubHostName.value.Split('.')[0]) --device-id Turbine_01"
Write-Host "   az iot hub device-identity connection-string show --hub-name $($output.properties.outputs.iotHubHostName.value.Split('.')[0]) --device-id Turbine_01"
