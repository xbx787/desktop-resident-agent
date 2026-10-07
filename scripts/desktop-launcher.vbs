' 静默启动桌面宠物 (npm run dev) - 桌面副本
' 此文件放在桌面，需要硬编码项目路径

Option Explicit
Dim WshShell, fso, projectDir, cmd, npmCmd

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 项目根目录（硬编码，因为此脚本在桌面）
projectDir = "D:\DesktopPetProject"

If Not fso.FolderExists(projectDir) Then
    WScript.Echo "项目目录不存在：" & projectDir
    WScript.Quit 1
End If

' 优先使用项目内的 npm.cmd
If fso.FileExists(projectDir & "\node_modules\.bin\npm.cmd") Then
    npmCmd = """" & projectDir & "\node_modules\.bin\npm.cmd"""
Else
    npmCmd = "npm"
End If

' cd 到项目目录并运行 npm run dev，窗口风格 0 = 隐藏
cmd = "cmd /c cd /d """ & projectDir & """ && " & npmCmd & " run dev"
WshShell.Run cmd, 0, False

' 短暂提示（3 秒后自动关闭）
WshShell.Popup "桌面宠物正在后台启动，请稍候…" & vbCrLf & vbCrLf & _
    "项目目录：" & projectDir & vbCrLf & _
    "首次启动需要几秒钟加载，请耐心等待 Electron 窗口出现。", 3, "桌面宠物", 64
