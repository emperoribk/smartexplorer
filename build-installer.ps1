<#
  One-command, RESUMABLE Windows installer build for SmartExplorer.

  Run from the repository root (the folder that contains electron-app\ and
  python-backend\):

      powershell -ExecutionPolicy Bypass -File .\build-installer.ps1

  If the build is interrupted (power cut, closed window, lost connection),
  just run the SAME command again. Finished steps are remembered in
  .build-state\ and skipped; a partly installed Python runtime is resumed
  and re-checked; downloads are served from the pip / npm / electron caches.

  Options:
      -SkipTesseract     do not bundle the Tesseract OCR engine
      -SkipModel         do not bundle the photo-search (CLIP) model; the app
                         then downloads it (~350 MB) on first launch instead
      -RebuildInstaller  redo only the npm + electron-builder step
      -Fresh             forget all progress and rebuild everything

  Steps: 1 pre-flight | 2 Python runtime | 3 Tesseract | 3b photo-search model | 3c Visual C++ runtime | 4 installer | 5 checks + checksum
  Log (appended across runs): build-installer.log
#>
param(
    [switch]$SkipTesseract,
    [switch]$SkipModel,
    [switch]$RebuildInstaller,
    [switch]$Fresh
)

$ErrorActionPreference = "Continue"
$Root    = $PSScriptRoot
$Backend = Join-Path $Root "python-backend"
$App     = Join-Path $Root "electron-app"
$Out     = Join-Path $App "dist_electron"
$State   = Join-Path $Root ".build-state"
$Log     = Join-Path $Root "build-installer.log"
$RuntimePy = Join-Path $Backend "runtime\python.exe"
$Req     = Join-Path $Backend "requirements.txt"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

Start-Transcript -Path $Log -Append | Out-Null

function Step($n, $text) { Write-Host ""; Write-Host "== Step $n : $text ==" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "  OK   $text" -ForegroundColor Green }
function Info($text) { Write-Host "  ...  $text" }
function Warn($text) { Write-Host "  WARN $text" -ForegroundColor Yellow }
function Fail($text) {
    Write-Host "  FAIL $text" -ForegroundColor Red
    Write-Host "  Fix the problem, then run the same command again - finished steps are kept." -ForegroundColor Yellow
    Stop-Transcript | Out-Null
    exit 1
}
function IsDone($name)   { return (Test-Path (Join-Path $State "$name.done")) }
function MarkDone($name) { (Get-Date -Format s) | Set-Content -Encoding ascii (Join-Path $State "$name.done") }

# Runs a native command with output captured, never throwing on stderr text.
function Invoke-Capture([string]$exe, [string[]]$arguments) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { $o = & $exe @arguments 2>&1 | ForEach-Object { $_.ToString() }; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
    return [pscustomobject]@{ Code = $code; Out = $o }
}

$ImportCheck = "import fastapi, uvicorn, torch, open_clip, PIL, numpy, pypdf, fitz, docx, watchdog, pdf2docx, img2pdf, openpyxl, cryptography, pytesseract; print('imports ok, torch', torch.__version__)"
function Test-Runtime {
    if (-not (Test-Path $RuntimePy)) { return $false }
    $r = Invoke-Capture $RuntimePy @("-c", $ImportCheck)
    return ($r.Code -eq 0)
}

if (-not (Test-Path $Req))                         { Fail "Run this from the repo root (python-backend\requirements.txt not found)." }
if (-not (Test-Path (Join-Path $App "package.json"))) { Fail "Run this from the repo root (electron-app\package.json not found)." }
New-Item -ItemType Directory -Force -Path $State | Out-Null
if ($Fresh) { Remove-Item (Join-Path $State "*") -Force -ErrorAction SilentlyContinue; Info "-Fresh: all earlier progress forgotten" }
if ($RebuildInstaller) { Remove-Item (Join-Path $State "installer.done") -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host ("Started " + (Get-Date -Format "yyyy-MM-dd HH:mm") + ". Progress from earlier runs:") -ForegroundColor Cyan
foreach ($n in @("runtime","tesseract","installer")) { $s = "not done"; if (IsDone $n) { $s = "done" }; Write-Host ("   {0,-10} {1}" -f $n, $s) }

# -------------------------------------------------------------------- 1
Step 1 "Pre-flight checks"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js was not found. Install the LTS version from https://nodejs.org and re-run." }
Ok ("Node " + (& node --version))
$drive = Get-PSDrive -Name ((Get-Location).Path.Substring(0,1))
$freeGB = [math]::Round($drive.Free / 1GB, 1)
if ($freeGB -lt 12) { Fail "Only $freeGB GB free on this drive. The build needs about 12 GB." } else { Ok "$freeGB GB free" }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$devMode = $false
try { $devMode = ((Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" -ErrorAction Stop).AllowDevelopmentWithoutDevLicense -eq 1) } catch {}
if ($isAdmin -or $devMode) { Ok "Can create symlinks (admin or Developer Mode)" }
else { Warn "Not Administrator and Developer Mode is off. If electron-builder fails with 'Cannot create symbolic link', re-run from an Administrator PowerShell." }

# -------------------------------------------------------------------- 2
Step 2 "Python runtime (the big download)"
if (-not $Fresh -and (IsDone "runtime") -and (Test-Runtime)) {
    Ok "Already built and verified - skipping"
} else {
    $resumed = $false
    if (-not $Fresh -and (Test-Path $RuntimePy)) {
        Info "Found a partly built runtime - resuming (packages already installed are skipped)"
        $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        & $RuntimePy -m pip install --no-warn-script-location --retries 10 --timeout 60 -r $Req
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prev
        if ($code -eq 0 -and (Test-Runtime)) { $resumed = $true; Ok "Resumed and verified" }
        else { Warn "Could not resume cleanly. Rebuilding the runtime from scratch (downloads are cached, so this is quicker than the first time)." }
    }
    if (-not $resumed) {
        Push-Location $Backend
        try {
            & powershell -ExecutionPolicy Bypass -File ".\build-runtime.ps1"
            if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "build-runtime.ps1 failed (exit $LASTEXITCODE)." }
        } finally { if ((Get-Location).Path -eq $Backend) { Pop-Location } }
        if (-not (Test-Runtime)) { Fail "The runtime was built but a required package does not import. See the log." }
    }
    $r = Invoke-Capture $RuntimePy @("-c", $ImportCheck); Ok ($r.Out | Select-Object -Last 1)
    MarkDone "runtime"
}

# -------------------------------------------------------------------- 3
Step 3 "Tesseract OCR (text inside photos and scans)"
$TessDest = Join-Path $Backend "tesseract"
if ($SkipTesseract) { Warn "Skipped (-SkipTesseract). OCR will not work on machines without Tesseract." }
elseif ((IsDone "tesseract") -and (Test-Path (Join-Path $TessDest "tesseract.exe"))) { Ok "Already bundled - skipping" }
else {
    $TessSrc = "C:\Program Files\Tesseract-OCR"
    if (Test-Path (Join-Path $TessSrc "tesseract.exe")) {
        New-Item -ItemType Directory -Force -Path $TessDest | Out-Null
        & robocopy $TessSrc $TessDest /E /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { Fail "Copying Tesseract failed (robocopy exit $LASTEXITCODE)." }
        Ok "Copied Tesseract from $TessSrc"
        MarkDone "tesseract"
    } else {
        Warn "Tesseract not found at $TessSrc. Install it from https://github.com/UB-Mannheim/tesseract/wiki and re-run, or accept an installer without OCR."
    }
}

# -------------------------------------------------------------------- 3b
# The CLIP weights (ViT-B-32, ~350 MB) power "search photos by what is in them".
# Shipping them inside the installer means the app works offline and the
# first-run indexing can start immediately instead of waiting on a download.
Step "3b" "Photo-search model (bundled, so nothing has to download later)"
$ModelDir  = Join-Path $Backend "models"
$ModelFile = Get-ChildItem $ModelDir -Recurse -Filter "open_clip_model.safetensors" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($SkipModel) { Warn "Skipped (-SkipModel). The app will download the model on first launch." }
elseif ((IsDone "model") -and $ModelFile -and ($ModelFile.Length -gt 300MB)) { Ok "Already bundled - skipping" }
else {
    New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
    Info "Downloading the model once into python-backend\models (checksum-verified by open_clip)"
    $code = "import sys, open_clip; open_clip.create_model_and_transforms('ViT-B-32', pretrained='openai', cache_dir=sys.argv[1]); print('model ok')"
    $r = Invoke-Capture $RuntimePy @("-c", $code, $ModelDir)
    $r.Out | Select-Object -Last 2 | ForEach-Object { Info $_ }
    $ModelFile = Get-ChildItem $ModelDir -Recurse -Filter "open_clip_model.safetensors" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($r.Code -ne 0 -or -not $ModelFile) { Fail "Could not fetch the photo-search model. Check your internet connection and run the same command again - it picks up here." }
    Info "Checking the app can load it from that file, offline ..."
    $chk = Invoke-Capture $RuntimePy @("-c", "import sys; sys.path.insert(0, sys.argv[1]); from app import embeddings; print('model-ready', embeddings.ensure_ready(), embeddings.model_source)", $Backend)
    $chk.Out | Select-Object -Last 1 | ForEach-Object { Info $_ }
    if (-not (($chk.Out -join " ") -match "model-ready True bundled")) { Fail "The model downloaded but the app could not load it from the bundled file. Send me the output above." }
    Ok ("Model bundled (" + [math]::Round($ModelFile.Length / 1MB, 0) + " MB) and loads from the file")
    MarkDone "model"
}

# -------------------------------------------------------------------- 3c
# PyTorch needs Microsoft's Visual C++ runtime. A fresh Windows PC may lack it
# (the app would start but photo search could not load), so the installer
# carries Microsoft's own redistributable and installs it silently only when
# the machine needs it (see electron-app\build\installer.nsh).
Step "3c" "Microsoft Visual C++ runtime (shipped inside the installer)"
$VcDir  = Join-Path $App "build"
$VcFile = Join-Path $VcDir "vc_redist.x64.exe"
function Test-VcRedist($path) {
    if (-not (Test-Path $path)) { return $false }
    if ((Get-Item $path).Length -lt 10MB) { return $false }
    $sig = Get-AuthenticodeSignature $path
    return ($sig.Status -eq "Valid" -and $sig.SignerCertificate.Subject -match "Microsoft Corporation")
}
if (Test-VcRedist $VcFile) { Ok "Already downloaded and verified - skipping" }
else {
    New-Item -ItemType Directory -Force -Path $VcDir | Out-Null
    Info "Downloading Microsoft's Visual C++ Redistributable (about 25 MB) ..."
    try {
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $VcFile -UseBasicParsing
    } catch { Fail ("Could not download the Visual C++ Redistributable: " + $_.Exception.Message + " Check your internet connection and run the same command again.") }
    if (-not (Test-VcRedist $VcFile)) {
        Remove-Item $VcFile -Force -ErrorAction SilentlyContinue
        Fail "The downloaded Visual C++ Redistributable is not a valid Microsoft-signed file, so it was discarded. Run the same command again."
    }
    Ok ("Downloaded and verified Microsoft's signature (" + [math]::Round((Get-Item $VcFile).Length / 1MB, 0) + " MB)")
}

# -------------------------------------------------------------------- 4
Step 4 "Installer (npm install, then electron-builder)"
$Installer = Get-ChildItem $Out -Filter "SmartExplorer-Setup-*.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ((IsDone "installer") -and $Installer -and -not $Fresh) {
    Ok ("Installer already built: " + $Installer.Name + " - skipping (use -RebuildInstaller after changing the source)")
} else {
    # A SmartExplorer window (or its Python backend) still running from the last
    # test build locks files in win-unpacked, and electron-builder then fails
    # with "Access is denied". Close anything running from there and clear it.
    $unpacked = Join-Path $Out "win-unpacked"
    if (Test-Path $unpacked) {
        $locked = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($unpacked, [System.StringComparison]::OrdinalIgnoreCase) }
        if ($locked) { Info ("Closing " + @($locked).Count + " process(es) still running from the previous test build"); $locked | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
        for ($i = 0; $i -lt 4 -and (Test-Path $unpacked); $i++) {
            Remove-Item $unpacked -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path $unpacked) { Start-Sleep -Seconds 3 }
        }
        if (Test-Path $unpacked) { Fail "Could not clear $unpacked. Close any File Explorer window open inside it and any running SmartExplorer, then run the same command again (antivirus scanning it can also hold it for a minute)." }
        Ok "Cleared the previous test build"
    }
    Push-Location $App
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install failed." }
        & npm run dist:win
        if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "electron-builder failed (see the output above)." }
    } finally { if ((Get-Location).Path -eq $App) { Pop-Location } }
    $Installer = Get-ChildItem $Out -Filter "SmartExplorer-Setup-*.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $Installer) { Fail "No SmartExplorer-Setup-*.exe found in $Out." }
    MarkDone "installer"
}
Ok ("Installer: " + $Installer.Name + "  (" + [math]::Round($Installer.Length / 1MB, 0) + " MB)")

# -------------------------------------------------------------------- 5
Step 5 "Checks and checksum"
$Packed   = Join-Path $Out "win-unpacked\resources\python-backend"
$PackedPy = Join-Path $Packed "runtime\python.exe"
if (-not (Test-Path $PackedPy)) { Fail "The packaged app does not contain python-backend\runtime\python.exe." }
if (-not (Test-Path (Join-Path (Split-Path $Packed -Parent) "vc_redist.x64.exe"))) { Fail "The Visual C++ runtime installer is not inside the packaged app. Re-run with -RebuildInstaller." }
if (Test-Path (Join-Path $Packed ".smartsearch")) { Fail "A .smartsearch index folder was bundled into the app. Delete it and use -RebuildInstaller." }
Ok "Runtime is bundled, no personal index folder inside"
if (-not $SkipModel) {
    if (-not (Get-ChildItem (Join-Path $Packed "models") -Recurse -Filter "open_clip_model.safetensors" -ErrorAction SilentlyContinue | Select-Object -First 1)) { Fail "The photo-search model is not inside the packaged app (python-backend\models). Re-run with -RebuildInstaller." }
    Info "Loading the bundled model from inside the packaged app (no internet needed) ..."
    $m = Invoke-Capture $PackedPy @("-c", "import sys; sys.path.insert(0, r'$Packed'); from app import embeddings; print('model-ready', embeddings.ensure_ready(), embeddings.model_source)")
    $m.Out | Select-Object -Last 1 | ForEach-Object { Info $_ }
    if (-not (($m.Out -join " ") -match "model-ready True bundled")) { Fail "The packaged app could not load its bundled photo-search model. Send me the output above." }
    Ok "Bundled photo-search model loads from inside the app"
}
Info "Starting the bundled backend the same way the app does, and asking it for /health ..."
$smokeData = Join-Path $env:TEMP "smartexplorer-smoke"
New-Item -ItemType Directory -Force -Path $smokeData | Out-Null
$env:SMARTSEARCH_APPDATA = $smokeData
$errFile = Join-Path $env:TEMP "smartexplorer-smoke-err.txt"
$outFile = Join-Path $env:TEMP "smartexplorer-smoke-out.txt"
$proc = Start-Process -FilePath $PackedPy -ArgumentList @("run.py", "8799") -WorkingDirectory $Packed -PassThru -WindowStyle Hidden -RedirectStandardError $errFile -RedirectStandardOutput $outFile
$healthy = $false
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) { break }
    try { $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8799/health" -TimeoutSec 2; if ($resp.StatusCode -eq 200) { $healthy = $true; break } } catch {}
}
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
if ($healthy) { Ok "Bundled backend started and answered /health" }
else {
    Write-Host "  --- backend output ---"
    if (Test-Path $errFile) { Get-Content $errFile -Tail 25 | ForEach-Object { Write-Host $_ } }
    Fail "The bundled backend did not start. Send me the output above (and the last lines of the log)."
}

$hash = (Get-FileHash $Installer.FullName -Algorithm SHA256).Hash.ToLower()
$sumFile = Join-Path $Out "SHA256SUMS.txt"
($hash + "  " + $Installer.Name) | Set-Content -Encoding ascii $sumFile
Ok "SHA-256: $hash"

Write-Host ""
Write-Host "DONE." -ForegroundColor Green
Write-Host "  Installer : $($Installer.FullName)"
Write-Host "  Checksum  : $sumFile"
Write-Host "  Try it    : $(Join-Path $Out 'win-unpacked\SmartExplorer.exe')  (runs without installing)"
Write-Host "  Log       : $Log"
Stop-Transcript | Out-Null
