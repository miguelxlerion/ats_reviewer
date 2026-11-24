#Requires -Version 5.1
<#
.SYNOPSIS
  Sirve CV Studio en local y libera el puerto al salir.

.DESCRIPTION
  - Busca el primer puerto libre a partir de -StartPort (3000 por defecto).
    Si 3000 está ocupado, prueba 3001, 3002, etc.
  - Sirve la carpeta del proyecto con "python -m http.server".
  - Al pulsar Ctrl+C (o cerrar la ventana) detiene el servidor y libera el puerto.
    El proceso de Python se asigna a un Job Object con KILL_ON_JOB_CLOSE, así que
    también muere si este script termina de forma abrupta.

.EXAMPLE
  .\run.ps1
  .\run.ps1 -StartPort 8080
  .\run.ps1 -Lan            # accesible desde otros equipos de la red
  .\run.ps1 -NoBrowser      # no abre el navegador
#>
param(
  [int]$StartPort = 3000,
  [int]$MaxAttempts = 50,
  [switch]$Lan,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSCommandPath
Set-Location $Root

# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
function Test-PortFree {
  param([int]$Port)
  # Comprueba IPv4 e IPv6: en Windows un proceso puede escuchar solo en :: o solo en 0.0.0.0
  foreach ($addr in @([System.Net.IPAddress]::Any, [System.Net.IPAddress]::IPv6Any)) {
    $listener = $null
    try {
      $listener = [System.Net.Sockets.TcpListener]::new($addr, $Port)
      if ($addr.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        $listener.Server.DualMode = $true
      }
      $listener.Start()
    } catch {
      return $false
    } finally {
      if ($listener) { try { $listener.Stop() } catch { } }
    }
  }
  return $true
}

function Find-Python {
  foreach ($name in @('python', 'py')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    $verArgs = if ($name -eq 'py') { @('-3', '--version') } else { @('--version') }
    try {
      $out = & $cmd.Source @verArgs 2>&1
      if ($LASTEXITCODE -eq 0 -and "$out" -match 'Python 3\.') {
        return @{
          Exe    = $cmd.Source
          Prefix = if ($name -eq 'py') { @('-3') } else { @() }
        }
      }
    } catch { }
  }
  return $null
}

# Job Object: garantiza que Python muera cuando este proceso desaparezca
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CvJob
{
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr info, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    public static IntPtr CreateKillOnClose()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(len);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            // 9 = JobObjectExtendedLimitInformation
            if (!SetInformationJobObject(job, 9, ptr, (uint)len))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
        return job;
    }
}
'@
} catch {
  Write-Host "  (aviso) No se pudo preparar el Job Object: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------------------
# Puerto libre
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  CV Studio" -ForegroundColor Cyan
Write-Host "  Buscando puerto libre desde $StartPort..." -ForegroundColor DarkGray

$Port = $null
for ($i = 0; $i -lt $MaxAttempts; $i++) {
  $candidate = $StartPort + $i
  if (Test-PortFree $candidate) {
    $Port = $candidate
    break
  }
  Write-Host ("    puerto {0} ocupado -> probando {1}" -f $candidate, ($candidate + 1)) -ForegroundColor DarkYellow
}

if (-not $Port) {
  Write-Host ("  ERROR: no hay puertos libres entre {0} y {1}." -f $StartPort, ($StartPort + $MaxAttempts - 1)) -ForegroundColor Red
  exit 1
}

if ($Port -ne $StartPort) {
  Write-Host "  El puerto $StartPort estaba en uso; se usará $Port." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------
$py = Find-Python
if (-not $py) {
  Write-Host "  ERROR: no se encontró Python 3 en el PATH." -ForegroundColor Red
  exit 1
}

$bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
$serverArgs = @($py.Prefix) + @('-m', 'http.server', "$Port", '--bind', $bind)

$server = Start-Process -FilePath $py.Exe -ArgumentList $serverArgs -WorkingDirectory $Root -PassThru -NoNewWindow

# Asignar al Job Object (si algo falla, seguimos con el finally normal)
$job = [IntPtr]::Zero
try { $job = [CvJob]::CreateKillOnClose() } catch { }
if ($job -ne [IntPtr]::Zero) {
  if (-not [CvJob]::AssignProcessToJobObject($job, $server.Handle)) {
    [CvJob]::CloseHandle($job) | Out-Null
    $job = [IntPtr]::Zero
  }
}

# ---------------------------------------------------------------------------
# Esperar a que responda
# ---------------------------------------------------------------------------
$url = "http://127.0.0.1:$Port/"
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  if ($server.HasExited) { break }
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1
    if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) { $ready = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 250
}

if (-not $ready) {
  Write-Host "  ERROR: el servidor no respondió en $url" -ForegroundColor Red
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  if ($job -ne [IntPtr]::Zero) { [CvJob]::CloseHandle($job) | Out-Null }
  exit 1
}

Write-Host ""
Write-Host "  Servidor listo:" -ForegroundColor Green
Write-Host "    $url" -ForegroundColor White
if ($Lan) {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
    Select-Object -ExpandProperty IPAddress
  foreach ($ip in $ips) { Write-Host "    http://${ip}:$Port/" -ForegroundColor DarkGray }
}
Write-Host ""
Write-Host "  Ctrl+C para detener (el puerto $Port se libera al salir)." -ForegroundColor DarkGray
Write-Host ""

if (-not $NoBrowser) {
  try { Start-Process $url | Out-Null } catch { }
}

# ---------------------------------------------------------------------------
# Esperar y limpiar
# ---------------------------------------------------------------------------
try {
  Wait-Process -Id $server.Id -ErrorAction SilentlyContinue
} finally {
  if ($server -and -not $server.HasExited) {
    Write-Host "  Deteniendo servidor..." -ForegroundColor DarkGray
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    try { $server.WaitForExit(3000) | Out-Null } catch { }
  }

  if ($job -ne [IntPtr]::Zero) {
    [CvJob]::CloseHandle($job) | Out-Null
    $job = [IntPtr]::Zero
  }

  $freed = $false
  for ($i = 0; $i -lt 20; $i++) {
    if (Test-PortFree $Port) { $freed = $true; break }
    Start-Sleep -Milliseconds 150
  }

  if ($freed) {
    Write-Host "  Puerto $Port liberado." -ForegroundColor Green
  } else {
    Write-Host "  Aviso: el puerto $Port sigue ocupado." -ForegroundColor Yellow
  }
}
