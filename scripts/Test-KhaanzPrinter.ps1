# Quick Windows print test without Node — run in PowerShell as Admin if drivers need it.
#   .\scripts\Test-KhaanzPrinter.ps1 -PrinterName "BillQuick Lite"
param(
  [Parameter(Mandatory = $true)]
  [string]$PrinterName
)

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:TEMP "khaanz-print-test"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$file = Join-Path $dir "khaanz-test.txt"

$p = Get-Printer -Name $PrinterName -ErrorAction Stop
Write-Host "Queue: $($p.Name)"
Write-Host "Port:  $($p.PortName)"
Write-Host "Driver: $($p.DriverName)"
Write-Host ""

@(
  "Khaanz POS",
  "TEST PRINT",
  "------------------------------",
  "If you can read this,",
  "your printer is connected.",
  (Get-Date).ToString("g"),
  "------------------------------",
  ""
) | Set-Content -Path $file -Encoding ASCII

Write-Host "Printing via notepad /pt ..."
$proc = Start-Process -FilePath notepad.exe -ArgumentList @("/pt", $file, $PrinterName) -PassThru -Wait -WindowStyle Minimized
if ($proc.ExitCode -ne 0) {
  throw "notepad exited with code $($proc.ExitCode)"
}

Start-Sleep -Seconds 2
$jobs = @(Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue)
if ($jobs.Count -gt 0) {
  Write-Host "Spooler: job queued (OK)"
} else {
  Write-Host "Spooler: no active job (may have finished already — check paper)"
}

Write-Host ""
Write-Host "If paper printed, Petpooja-style GDI works. Run: node scripts/test-windows-print.cjs `"$PrinterName`""
