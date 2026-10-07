' 静默启动桌面宠物 (npm run dev)
' 双击此文件即可启动，不会弹出任何命令行窗口
' 关闭 Electron 窗口时 npm 进程会自动退出

Option Explicit
Dim WshShell, fso, scriptDir, cmd, npmCmd

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 获取此脚本所在目录（即项目根目录）
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 优先使用项目内的 npm.cmd，避免依赖全局 PATH
If fso.FileExists(scriptDir & "\node_modules\.bin\npm.cmd") Then
    npmCmd = """" & scriptDir & "\node_modules\.bin\npm.cmd"""
Else
    npmCmd = "npm"
End If

' cd 到项目目录并运行 npm run dev，窗口风格 0 = 隐藏
cmd = "cmd /c cd /d """ & scriptDir & """ && " & npmCmd & " run dev"

' 第二个参数 0 表示隐藏 cmd 窗口；第三个参数 False 表示不等待执行结束
WshShell.Run cmd, 0, False

' 短暂提示（3 秒后自动关闭）
WshShell.Popup "桌面宠物正在后台启动，请稍候…" & vbCrLf & vbCrLf & _
    "项目目录：" & scriptDir & vbCrLf & _
    "首次启动需要几秒钟加载，请耐心等待 Electron 窗口出现。", 3, "桌面宠物", 64
