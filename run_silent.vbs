Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\Yohan\Stores Database"
WshShell.Run "cmd /c start_server_silent.bat", 0, False
Set WshShell = Nothing