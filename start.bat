@echo off
:: Start the bot using PM2
pm2 start "C:\Users\defus\Desktop\bot\index.js" --name discord-bot

:: Run logs.bat in a new command window
start cmd /k "C:\Users\defus\Desktop\bot\logs.bat"
