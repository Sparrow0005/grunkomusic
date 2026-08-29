Option Explicit

Dim shell, fileSystem, scriptDirectory, watchdog, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
watchdog = fileSystem.BuildPath(scriptDirectory, "watchdog.ps1")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & watchdog & """"

' Window style 0 keeps both PowerShell and its child processes off the desktop.
WScript.Quit shell.Run(command, 0, True)
