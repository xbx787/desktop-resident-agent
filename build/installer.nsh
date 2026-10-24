; 安装器附加逻辑：升级或卸载时保住安装目录里的用户数据（data/）。
; electron-builder 的 NSIS 在覆盖安装前会运行旧卸载器并清空 $INSTDIR，
; 这里先把 data 挪到 %APPDATA%，安装完成后再搬回，避免对话与记忆丢失。

!macro customUnInstall
  ${If} ${FileExists} "$INSTDIR\data\*.*"
    RMDir /r "$APPDATA\WhaleCompanionDataBackup"
    CreateDirectory "$APPDATA\WhaleCompanionDataBackup"
    nsExec::ExecToLog 'robocopy "$INSTDIR\data" "$APPDATA\WhaleCompanionDataBackup" /E /MOVE /NFL /NDL /NJH /NJS'
  ${EndIf}
!macroend

!macro customInstall
  ${If} ${FileExists} "$APPDATA\WhaleCompanionDataBackup\*.*"
  ${AndIfNot} ${FileExists} "$INSTDIR\data\*.*"
    nsExec::ExecToLog 'robocopy "$APPDATA\WhaleCompanionDataBackup" "$INSTDIR\data" /E /MOVE /NFL /NDL /NJH /NJS'
  ${EndIf}
!macroend
