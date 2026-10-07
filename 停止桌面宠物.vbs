' 静默停止桌面宠物
' 关闭 Electron 窗口和后台 npm/electron 进程

Option Explicit
Dim WshShell, fso, projectDir
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = "D:\DesktopPetProject"

' 终止 electron 进程（dev 模式下 electron.exe 是主进程）
WshShell.Run "taskkill /f /im electron.exe", 0, True

' 终止可能残留的 node 进程（只杀 dev 服务器，不动其他 node）
' 通过窗口标题匹配 desktop-resident-agent
WshShell.Run "cmd /c taskkill /f /fi ""WINDOWTITLE eq desktop-resident-agent*"" /im node.exe", 0, True

WshShell.Popup "桌面宠物已停止", 2, "桌面宠物", 64
