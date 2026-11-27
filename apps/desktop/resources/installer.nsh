!include "StrFunc.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
  !define T3StrRep '${UnStrRep}'
!else
  ${StrRep}
  !define T3StrRep '${StrRep}'
  Var PreviousInstallDir
!endif

!macro customInit
  !ifndef BUILD_UNINSTALLER
    StrCpy $PreviousInstallDir ""
    ReadRegStr $PreviousInstallDir HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $PreviousInstallDir == ""
      ReadRegStr $PreviousInstallDir HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${EndIf}
  !endif
!macroend

!macro customAppRunningMessages
  Push $0
  Push $1
  ${If} $IsPowerShellAvailable == 0
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", t "$INSTDIR")'
    nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and [IO.Path]::GetDirectoryName($$_.ExecutablePath) -eq $$env:T3CODE_INSTALL_DIR } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($$_.ExecutablePath) } | Where-Object { $$_ -in 'T3 Code (Alpha)', 'T3 Code (Beta)', 'T3 Code (Nightly)' } | Select-Object -First 1 | ForEach-Object { [Console]::Write($$_) }"`
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", p 0)'
    ${If} $0 == 0
      ${If} $1 == "T3 Code (Alpha)"
      ${OrIf} $1 == "T3 Code (Beta)"
      ${OrIf} $1 == "T3 Code (Nightly)"
        ${T3StrRep} $appRunningMessage $appRunningMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appClosingMessage $appClosingMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appCannotBeClosedMessage $appCannotBeClosedMessage "${PRODUCT_NAME}" $1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
  !ifndef BUILD_UNINSTALLER
    ${If} $PreviousInstallDir != ""
    ${AndIf} $PreviousInstallDir != $INSTDIR
      ; When relocating an existing install (for example from C: to D:), remove
      ; any leftover uninstaller stub and empty directory at the previous location.
      ; User data under %USERPROFILE%\.t3 / .quixotic and %APPDATA% is never touched.
      Delete /REBOOTOK "$PreviousInstallDir\Uninstall *.exe"
      RMDir "$PreviousInstallDir"
    ${EndIf}
  !endif
!macroend
