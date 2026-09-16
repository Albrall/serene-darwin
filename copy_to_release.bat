@echo off
mkdir "vault-copilot-release" 2>nul
copy "main.js" "vault-copilot-release\main.js" /Y
copy "manifest.json" "vault-copilot-release\manifest.json" /Y
copy "styles.css" "vault-copilot-release\styles.css" /Y
echo Files copied successfully to vault-copilot-release folder.
pause
