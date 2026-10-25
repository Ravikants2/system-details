[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$owner = "Ravikants2"
$repositoryName = "system-details-data"
$branch = "main"
$reportWarnings = [System.Collections.Generic.List[string]]::new()

if ($env:OS -ne "Windows_NT") {
    throw "This collector only supports Windows."
}

Write-Host ""
Write-Host "SYSTEM DETAILS - MANUAL WINDOWS COLLECTION" -ForegroundColor Cyan
Write-Host "This script runs only when you start it. It does not install a service,"
Write-Host "schedule a task, or run in the background."
Write-Host ""
Write-Host "If you continue, it will read this computer's OS/model/CPU/RAM, the"
Write-Host "current account, physical NIC names/MACs/private IPv4 addresses, the"
Write-Host "installed-app inventory, and up to 60 recent boot/shutdown event IDs."
Write-Host "It will also query ipwho.is for your public IP and ISP, and Cloudflare"
Write-Host "speed.cloudflare.com for a 5 MB download and 1 MB upload speed test."
Write-Host "Those two external providers will receive network requests from this"
Write-Host "device. A report preview is shown before a separate upload confirmation."
Write-Host "Only an upload you confirm is sent to the private GitHub repository:"
Write-Host "https://github.com/$owner/$repositoryName"
Write-Host "The report includes sensitive account and network identifiers."
Write-Host ""

$collectionConsent = Read-Host 'Type COLLECT to continue, or anything else to exit'
if ($collectionConsent -cne "COLLECT") {
    Write-Host "No system report was collected or uploaded."
    exit 0
}

$ghCommand = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghCommand) {
    throw "GitHub CLI (gh) is required. Install it from https://cli.github.com/ and authenticate with 'gh auth login'."
}

$ghLogin = & $ghCommand.Source api user --jq .login
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI authentication failed. Run 'gh auth login' and try again."
}
if ($ghLogin.Trim() -ne $owner) {
    throw "GitHub CLI is authenticated as '$($ghLogin.Trim())', not '$owner'. No data was collected."
}

$repoJson = & $ghCommand.Source api "repos/$owner/$repositoryName"
if ($LASTEXITCODE -ne 0) {
    throw "Could not read the private telemetry repository. Check GitHub CLI permissions and repository access."
}
$repoInfo = $repoJson | ConvertFrom-Json
if ($repoInfo.private -ne $true) {
    throw "Refusing to continue because $owner/$repositoryName is not private."
}

function Test-PrivateIPv4 {
    param([string]$Address)

    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) {
        return $false
    }
    if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        return $false
    }

    $octets = $Address.Split(".") | ForEach-Object { [int]$_ }
    return (
        $octets[0] -eq 10 -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168)
    )
}

function Add-ReportWarning {
    param(
        [string]$Section,
        [System.Exception]$Exception
    )

    $message = "$Section unavailable: $($Exception.Message)"
    $reportWarnings.Add($message)
    Write-Warning $message
}

$computer = Get-CimInstance -ClassName Win32_ComputerSystem
$operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
$processor = Get-CimInstance -ClassName Win32_Processor |
    Select-Object -First 1
$networkAdapters = @(
    Get-CimInstance -ClassName Win32_NetworkAdapter |
        Where-Object { $_.PhysicalAdapter -and $_.MACAddress }
)
$networkConfigurations = @(
    Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration |
        Where-Object { $_.IPEnabled }
)

$networkDetails = foreach ($adapter in $networkAdapters) {
    $configuration = $networkConfigurations |
        Where-Object { $_.MACAddress -eq $adapter.MACAddress } |
        Select-Object -First 1
    $privateIPv4 = @()
    if ($configuration) {
        $privateIPv4 = @(
            $configuration.IPAddress |
                Where-Object { Test-PrivateIPv4 -Address $_ }
        )
    }

    [PSCustomObject]@{
        name = $adapter.NetConnectionID
        description = $adapter.Name
        status = $adapter.NetConnectionStatus
        macAddress = $adapter.MACAddress
        privateIPv4Addresses = $privateIPv4
    }
}

$installedApps = [System.Collections.Generic.List[object]]::new()
$uninstallPaths = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
foreach ($uninstallPath in $uninstallPaths) {
    try {
        if (Test-Path ($uninstallPath -replace "\\\*$", "")) {
            foreach ($application in (Get-ItemProperty -Path $uninstallPath)) {
                if ($application.DisplayName) {
                    $installedApps.Add([PSCustomObject]@{
                        name = [string]$application.DisplayName
                        version = [string]$application.DisplayVersion
                        publisher = [string]$application.Publisher
                        installDate = [string]$application.InstallDate
                    })
                }
            }
        }
    } catch {
        Add-ReportWarning -Section "Installed applications ($uninstallPath)" -Exception $_.Exception
    }
}

$bootShutdownEvents = @()
$eventIds = @(41, 1074, 6005, 6006, 6008)
try {
    $bootShutdownEvents = @(
        Get-WinEvent -FilterHashtable @{
            LogName = "System"
            Id = $eventIds
            StartTime = (Get-Date).AddDays(-180)
        } -MaxEvents 60 |
            ForEach-Object {
                [PSCustomObject]@{
                    eventId = $_.Id
                    timestamp = $_.TimeCreated.ToUniversalTime().ToString("o")
                    provider = $_.ProviderName
                }
            }
    )
} catch {
    if ($_.Exception.Message -notmatch "No events were found") {
        Add-ReportWarning -Section "Boot/shutdown event log" -Exception $_.Exception
    }
}

$publicNetwork = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $lookup = Invoke-RestMethod -Uri "https://ipwho.is/" -TimeoutSec 15
    if ($lookup.success -ne $true) {
        throw "The IP lookup provider did not return a successful result."
    }
    $publicNetwork = [PSCustomObject]@{
        publicIp = [string]$lookup.ip
        isp = [string]$lookup.connection.isp
        provider = "ipwho.is"
    }
} catch {
    Add-ReportWarning -Section "Public IP/ISP lookup (ipwho.is)" -Exception $_.Exception
}

$internetSpeed = $null
Add-Type -AssemblyName System.Net.Http
$httpClient = [System.Net.Http.HttpClient]::new()
$httpClient.Timeout = [TimeSpan]::FromSeconds(30)
try {
    $downloadTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $download = $httpClient.GetByteArrayAsync(
        "https://speed.cloudflare.com/__down?bytes=5000000"
    ).GetAwaiter().GetResult()
    $downloadTimer.Stop()

    $uploadPayload = [byte[]]::new(1000000)
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($uploadPayload)
    } finally {
        $random.Dispose()
    }

    $uploadContent = [System.Net.Http.ByteArrayContent]::new($uploadPayload)
    try {
        $uploadTimer = [System.Diagnostics.Stopwatch]::StartNew()
        $uploadResponse = $httpClient.PostAsync(
            "https://speed.cloudflare.com/__up",
            $uploadContent
        ).GetAwaiter().GetResult()
        $uploadTimer.Stop()
        $uploadResponse.EnsureSuccessStatusCode()

        $internetSpeed = [PSCustomObject]@{
            downloadMbps = [Math]::Round(
                ($download.Length * 8 / $downloadTimer.Elapsed.TotalSeconds / 1000000),
                2
            )
            uploadMbps = [Math]::Round(
                ($uploadPayload.Length * 8 / $uploadTimer.Elapsed.TotalSeconds / 1000000),
                2
            )
            provider = "Cloudflare speed.cloudflare.com"
        }
    } finally {
        $uploadContent.Dispose()
    }
} catch {
    Add-ReportWarning -Section "Internet speed test (Cloudflare)" -Exception $_.Exception
} finally {
    $httpClient.Dispose()
}

$record = [PSCustomObject]@{
    schemaVersion = 2
    collectedAt = [DateTime]::UtcNow.ToString("o")
    deviceName = [string]$env:COMPUTERNAME
    currentAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    operatingSystem = [PSCustomObject]@{
        name = $operatingSystem.Caption
        version = $operatingSystem.Version
        build = $operatingSystem.BuildNumber
        architecture = $operatingSystem.OSArchitecture
        lastBootTime = $operatingSystem.LastBootUpTime.ToUniversalTime().ToString("o")
        uptimeSeconds = [Math]::Round(
            ((Get-Date) - $operatingSystem.LastBootUpTime).TotalSeconds
        )
    }
    hardware = [PSCustomObject]@{
        manufacturer = $computer.Manufacturer
        model = $computer.Model
        totalMemoryGiB = [Math]::Round($computer.TotalPhysicalMemory / 1GB, 2)
        processor = $processor.Name
        logicalProcessors = $processor.NumberOfLogicalProcessors
    }
    networkAdapters = @($networkDetails)
    networkAdapterCount = $networkAdapters.Count
    publicNetwork = $publicNetwork
    internetSpeed = $internetSpeed
    installedApplications = @($installedApps | Select-Object -First 1000)
    installedApplicationCount = $installedApps.Count
    installedApplicationsTruncated = $installedApps.Count -gt 1000
    recentBootShutdownEvents = $bootShutdownEvents
    eventHistoryDays = 180
    warnings = @($reportWarnings)
}

Write-Host ""
Write-Host "REPORT PREVIEW" -ForegroundColor Cyan
Write-Host "Device: $($record.deviceName)"
Write-Host "Current account: $($record.currentAccount)"
Write-Host "Operating system: $($record.operatingSystem.name) $($record.operatingSystem.version)"
Write-Host "Last boot (UTC): $($record.operatingSystem.lastBootTime)"
Write-Host "Physical network adapters: $($record.networkAdapterCount)"
Write-Host "Installed applications: $($record.installedApplicationCount)"
Write-Host "Recent boot/shutdown events: $($record.recentBootShutdownEvents.Count)"
if ($record.publicNetwork) {
    Write-Host "Public IP: $($record.publicNetwork.publicIp)"
    Write-Host "ISP: $($record.publicNetwork.isp)"
}
if ($record.internetSpeed) {
    Write-Host "Internet speed: $($record.internetSpeed.downloadMbps) Mbps down / $($record.internetSpeed.uploadMbps) Mbps up"
}
if ($record.installedApplicationCount -gt 0) {
    $previewApps = @($record.installedApplications | Select-Object -First 10)
    Write-Host "Application preview: $((@($previewApps | ForEach-Object { $_.name }) -join ', '))"
    if ($record.installedApplicationCount -gt $previewApps.Count) {
        Write-Host "... and $($record.installedApplicationCount - $previewApps.Count) more application records."
    }
}

Write-Host ""
Write-Host "This report contains sensitive account, network, app inventory, and"
Write-Host "system uptime data. It will be stored in the private GitHub repo."
$uploadConsent = Read-Host 'Type UPLOAD to commit this report, or anything else to cancel'
if ($uploadConsent -cne "UPLOAD") {
    Write-Host "Report cancelled. No system report was uploaded."
    exit 0
}

$json = $record | ConvertTo-Json -Depth 8
$content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$fileName = "{0}--{1}.json" -f (
    [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ"),
    [Guid]::NewGuid().ToString("N")
)
$endpoint = "repos/$owner/$repositoryName/contents/data/records/$fileName"
$payload = [PSCustomObject]@{
    message = "Add manually approved Windows system report"
    branch = $branch
    content = $content
} | ConvertTo-Json -Depth 4
$payloadPath = Join-Path ([IO.Path]::GetTempPath()) (
    "system-details-upload-{0}.json" -f [Guid]::NewGuid().ToString("N")
)

try {
    [IO.File]::WriteAllText($payloadPath, $payload, [Text.Encoding]::ASCII)
    $uploadResult = & $ghCommand.Source api --method PUT --input $payloadPath $endpoint
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub rejected the report upload. Check repository permissions and try again."
    }
    $result = $uploadResult | ConvertFrom-Json
    Write-Host ""
    Write-Host "Report uploaded to the private repository:" -ForegroundColor Green
    Write-Host $result.content.html_url
} finally {
    if (Test-Path $payloadPath) {
        Remove-Item -LiteralPath $payloadPath -Force
    }
}
