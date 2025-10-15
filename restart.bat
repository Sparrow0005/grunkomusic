@echo off

yt-dlp -U
pm2 restart all --update-env