# Clipy setup for Windows 10/11. Idempotent: run it again after pulling updates.
#   powershell -ExecutionPolicy Bypass -File setup.ps1 [-Backend auto|cuda|directml|cpu]
param(
    [ValidateSet("auto", "cuda", "directml", "cpu")]
    [string]$Backend = "auto"
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- tools
Step "Checking tools"
$winget = Get-Command winget -ErrorAction SilentlyContinue

function Ensure-Tool($name, $wingetId) {
    if (Get-Command $name -ErrorAction SilentlyContinue) { Write-Host "  $name: ok"; return }
    if (-not $winget) { Fail "$name is missing and winget is not available. Install $name manually and add it to PATH." }
    Write-Host "  $name: installing via winget ($wingetId)"
    & winget install -e --id $wingetId --accept-source-agreements --accept-package-agreements | Out-Null
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { Fail "$name was installed but is not on PATH yet. Open a new terminal and run setup.bat again." }
}
Ensure-Tool "git" "Git.Git"
Ensure-Tool "ffmpeg" "Gyan.FFmpeg"
Ensure-Tool "curl" "cURL.cURL"
Ensure-Tool "node" "OpenJS.NodeJS.LTS"

# Python 3.12 preferred (FaceFusion 3.9 pins), 3.11 also works with relaxed scipy
$py = $null
foreach ($v in @("3.12", "3.11")) {
    try { $out = & py "-$v" -c "import sys;print(sys.version)" 2>$null; if ($LASTEXITCODE -eq 0 -and $out) { $py = "-$v"; break } } catch {}
}
if (-not $py) {
    if (-not $winget) { Fail "Python 3.11/3.12 not found. Install Python 3.12 from python.org and run setup.bat again." }
    Write-Host "  python: installing 3.12 via winget"
    & winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements | Out-Null
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $py = "-3.12"
}
Write-Host "  python: py $py"

# ---------------------------------------------------------------- backend choice
if ($Backend -eq "auto") {
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { $Backend = "cuda" } else { $Backend = "directml" }
}
Write-Host "  backend: $Backend"

# ---------------------------------------------------------------- venv + deps
Step "Python environment (.venv)"
if (-not (Test-Path ".venv\Scripts\python.exe")) { & py $py -m venv .venv }
$python = Join-Path $Root ".venv\Scripts\python.exe"
& $python -m pip install --upgrade pip --quiet
& $python -m pip install -r backend\requirements.txt --quiet
if ($LASTEXITCODE -ne 0) { Fail "pip install failed (see output above)" }
& $python -m pip uninstall -y -q onnxruntime onnxruntime-gpu onnxruntime-directml 2>$null | Out-Null
switch ($Backend) {
    "cuda" {
        # onnxruntime-gpu 1.24.4 (FaceFusion's cuda@12 pin) + CUDA 12.9 / cuDNN 9.10 runtime from pip, no CUDA toolkit needed
        & $python -m pip install --quiet "onnxruntime-gpu==1.24.4" "nvidia-cuda-runtime-cu12==12.9.*" "nvidia-cublas-cu12==12.9.*" "nvidia-cufft-cu12==11.4.*" "nvidia-curand-cu12==10.3.*" "nvidia-cuda-nvrtc-cu12==12.9.*" "nvidia-cudnn-cu12==9.10.*"
    }
    "directml" { & $python -m pip install --quiet "onnxruntime-directml==1.24.4" }
    "cpu" { & $python -m pip install --quiet "onnxruntime==1.29.0" }
}
if ($LASTEXITCODE -ne 0) { Fail "onnxruntime install failed" }

# ---------------------------------------------------------------- FaceFusion engine
Step "FaceFusion engine"
$ff = Join-Path $Root "engines\facefusion"
if (-not (Test-Path (Join-Path $ff "facefusion.py"))) {
    New-Item -ItemType Directory -Force (Join-Path $Root "engines") | Out-Null
    & git clone --depth 1 --branch 3.9.0 https://github.com/facefusion/facefusion.git $ff
    if ($LASTEXITCODE -ne 0) { Fail "git clone of FaceFusion failed" }
} else { Write-Host "  already cloned" }

Step "Downloading face models (first time: ~1.5 GB)"
$providers = @("cpu")
if ($Backend -eq "cuda") { $providers = @("cuda", "cpu") } elseif ($Backend -eq "directml") { $providers = @("directml", "cpu") }
& $python backend\app\engine\ff_download.py --providers @providers
if ($LASTEXITCODE -ne 0) { Write-Host "  some models failed to download; they will be retried on the first job" -ForegroundColor Yellow }

# ---------------------------------------------------------------- frontend
Step "Frontend build"
Push-Location frontend
if (-not (Test-Path "node_modules")) { & npm install --no-audit --no-fund }
& npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "frontend build failed" }
Pop-Location

# ---------------------------------------------------------------- data dirs + GPU check
Step "Data folders and GPU check"
foreach ($d in @("data", "data\faces", "data\identities", "data\downloads", "data\sources", "data\jobs", "data\outputs", "data\temp", "data\models", "data\logs", "data\uploads", "data\backgrounds")) {
    New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null
}
Push-Location backend
& $python -c "from app import hardware; hw = hardware.detect(); print('  GPU: ' + (hw.gpu_name or 'none')); print('  Backend: ' + hw.backend.upper()); print('  ' + ' | '.join(hw.notes)) if hw.notes else None"
Pop-Location

Write-Host ""
Write-Host "Setup complete. Run start.bat and open http://localhost:8500/clipy/" -ForegroundColor Green
