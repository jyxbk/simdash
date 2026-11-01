@echo off
rem Richtet den Autostart ein: Collector startet unsichtbar bei der Anmeldung
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\SimDash-Collector.bat" echo @start "" pyw -3 "%~dp0simdash_collector.py"
echo Autostart eingerichtet: %STARTUP%\SimDash-Collector.bat
start "" pyw -3 "%~dp0simdash_collector.py"
echo Collector laeuft jetzt im Hintergrund. Log: %LOCALAPPDATA%\SimDash\collector.log
pause
