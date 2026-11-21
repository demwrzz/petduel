@echo off
chcp 65001 >nul
title PetDuel Discord Bot
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js bulunamadi. https://nodejs.org adresinden LTS surumunu kurup tekrar calistir.
  echo.
  pause
  exit /b
)

if not exist ".env" (
  echo.
  echo  .env dosyasi yok. .env.example dosyasini kopyalayip adini .env yap ve icini doldur.
  echo.
  pause
  exit /b
)

if not exist "node_modules\discord.js" (
  echo  Gerekli paketler kuruluyor, ilk seferde 1-2 dakika surebilir...
  call npm install --omit=dev --no-audit --no-fund
)

:loop
echo.
echo  [%date% %time%] PetDuel bot baslatiliyor...
node index.js
echo.
echo  Bot kapandi. 5 saniye sonra yeniden baslatilacak (kapatmak icin bu pencereyi kapat).
timeout /t 5 /nobreak >nul
goto loop
