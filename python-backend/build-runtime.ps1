<#
  Builds a fully self-contained Python runtime in python-backend\runtime\,
  with every one of SmartExplorer's dependencies (torch, open_clip, etc.)
  already installed into it.

  This is what gets bundled into the Windows installer, so that someone who
  installs SmartExplorer on a machine with no Python at all still has search
  work out of the box - nothing to set up, nothing to pip install.

  Run this ONCE (from inside python-backend\) before building a distributable
  installer:

      cd python-backend
      powershell -ExecutionPolicy Bypass -File build-runtime.ps1
      cd ..\electron-app
      npm run dist:win

  It downloads a few hundred MB up front (the embeddable Python + pip) and
  then a further ~1-2GB for torch and its dependencies, so it needs a decent
  connection and will take a while - that's expected. You only need to run
  it again if requirements.txt changes.

  This does NOT touch python-backend\.venv - that's your separate dev
  environment (used by `npm run electron:dev`) and is never bundled into the
  installer. This script only produces the "runtime" folder that ships
  instead, for a packaged install.
#>

$ErrorActionPreference = "Stop"

$PythonVersion = "3.11.9"
$RuntimeDir = Join-Path $PSScriptRoot "runtime"
$ZipUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$ZipPath = Join-Path $env:TEMP "smartexplorer-python-embed-$PythonVersion.zip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"
$GetPipPath = Join-Path $env:TEMP "smartexplorer-get-pip.py"
$RequirementsPath = Join-Path $PSScriptRoot "requirements.txt"

if (-not (Test-Path $RequirementsPath)) {
    Write-Error "Couldn't find requirements.txt next to this script - run it from inside python-backend\."
    exit 1
}

if (Test-Path $RuntimeDir) {
    Write-Host "Removing existing runtime\ folder..."
    Remove-Item -Recurse -Force $RuntimeDir
}
New-Item -ItemType Directory -Path $RuntimeDir | Out-Null

Write-Host "Downloading embeddable Python $PythonVersion..."
Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath

Write-Host "Extracting..."
Expand-Archive -Path $ZipPath -DestinationPath $RuntimeDir -Force

# The embeddable distribution ships with the "site" module (and therefore
# site-packages) disabled, and has no pip at all. Re-enable both so we can
# install real dependencies into it like a normal Python install.
$PthFile = Get-ChildItem -Path $RuntimeDir -Filter "python3*._pth" | Select-Object -First 1
if (-not $PthFile) {
    Write-Error "Couldn't find the python3xx._pth file inside the extracted runtime - Python's embeddable package layout may have changed."
    exit 1
}
(Get-Content $PthFile.FullName) -replace '#import site', 'import site' | Set-Content $PthFile.FullName
Add-Content $PthFile.FullName "`nLib\site-packages"

$RuntimePython = Join-Path $RuntimeDir "python.exe"

Write-Host "Bootstrapping pip..."
Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPipPath
& $RuntimePython $GetPipPath --no-warn-script-location

Write-Host ""
Write-Host "Installing dependencies into the bundled runtime (this is the big download - torch alone is several hundred MB, be patient)..."
& $RuntimePython -m pip install --no-warn-script-location -r $RequirementsPath

Write-Host ""
Write-Host "Done. python-backend\runtime\ is a self-contained Python with everything" -ForegroundColor Green
Write-Host "SmartExplorer needs already installed. It'll be bundled automatically the" -ForegroundColor Green
Write-Host "next time you run 'npm run dist:win' in electron-app\." -ForegroundColor Green
Write-Host ""
Write-Host "Optional: for OCR (reading text out of images) to work in the packaged app" -ForegroundColor Yellow
Write-Host "too, see the 'Bundling Tesseract for distribution' section in the README." -ForegroundColor Yellow
