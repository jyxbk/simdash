@echo off
rem SimDash-Collector mit Konsolenfenster starten (zum Testen)
cd /d "%~dp0"
py -3 simdash_collector.py %*
pause
