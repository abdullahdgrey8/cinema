@echo off
set "CINEMA_ROOT=%~dp0"
powershell.exe -NoProfile -Command "$cinemaReady=$false; try { $null=Invoke-WebRequest 'http://127.0.0.1:3210/api/session' -UseBasicParsing -TimeoutSec 2; $cinemaReady=$true } catch {}; if (-not $cinemaReady) { Start-Process -FilePath 'node.exe' -ArgumentList 'server.mjs' -WorkingDirectory $env:CINEMA_ROOT -WindowStyle Hidden; Start-Sleep -Seconds 2 }; Start-Process 'http://127.0.0.1:3210'"
