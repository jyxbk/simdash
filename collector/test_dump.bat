@echo off
rem Live-Werte anzeigen, um zu pruefen, ob das Spiel richtig gelesen wird
cd /d "%~dp0"
py -3 simdash_collector.py --dump
pause
