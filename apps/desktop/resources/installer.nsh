!include "StrFunc.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
  !define T3StrRep '${UnStrRep}'

  !macro customRemoveFiles
    ${if} ${isUpdated}
      StrCpy $R1 $INSTDIR 2
      StrCpy $R2 $PLUGINSDIR 2
      ; NSIS Rename calls MoveFileW, which always fails across drives (e.g. D:\Quixotic -> C:\...\Temp).
      ; Only use electron-builder's atomic rename-to-$PLUGINSDIR when both paths share the same drive.
      ${if} $R1 == $R2
        CreateDirectory "$PLUGINSDIR\old-install"

        Push ""
        Call un.atomicRMDir
        Pop $R0

        ${if} $R0 != 0
          DetailPrint "File is busy, aborting: $R0"

          Push ""
          Call un.restoreFiles
          Pop $R0

          Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
        ${endif}
      ${endif}
    ${endif}

    SetOutPath $TEMP
    RMDir /r $INSTDIR
  !macroend
!else
  ${StrRep}
  !define T3StrRep '${StrRep}'
  !include "getProcessInfo.nsh"
  Var pid
  Var PreviousInstallDir
  Var t3AppWasRunning

  !macro quixoticPreUninstallCrossDrive ROOT_KEY
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $R0
    Push $R1
    Push $R2

    !insertmacro readReg $1 "${ROOT_KEY}" "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${if} $1 == ""
      !ifdef UNINSTALL_REGISTRY_KEY_2
        !insertmacro readReg $1 "${ROOT_KEY}" "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      !endif
    ${endif}

    ${if} $1 != ""
      !insertmacro GetInQuotes $2 "$1"
      !insertmacro readReg $3 "${ROOT_KEY}" "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${if} $3 == ""
      ${andIf} $2 != ""
        Push $2
        Call GetFileParent
        Pop $3
      ${endif}

      ${if} $3 != ""
      ${andIf} $2 != ""
      ${andIf} ${FileExists} "$2"
        StrCpy $R1 $3 2
        StrCpy $R2 $PLUGINSDIR 2
        ${if} $R1 != $R2
          ; Previous versions (e.g. beta.4) used electron-builder's un.atomicRMDir, which fails
          ; with exit code 2 when --updated is passed and $INSTDIR is on a different drive than %TEMP%.
          ; Invoke the old uninstaller silently without --updated (/KEEP_APP_DATA preserves user data).
          ${if} $installMode == "CurrentUser"
          ${orIf} "${ROOT_KEY}" == "HKEY_CURRENT_USER"
            StrCpy $4 "/currentuser"
          ${else}
            StrCpy $4 "/allusers"
          ${endif}
          !insertmacro copyFile "$2" "$PLUGINSDIR\old-uninstaller-crossdrive.exe"
          ClearErrors
          ExecWait '"$PLUGINSDIR\old-uninstaller-crossdrive.exe" /S /KEEP_APP_DATA $4 _?=$3' $R0
          ${if} ${Errors}
            ClearErrors
            ExecWait '"$2" /S /KEEP_APP_DATA $4 _?=$3' $R0
          ${elseif} $R0 != 0
            Sleep 1000
            ClearErrors
            ExecWait '"$PLUGINSDIR\old-uninstaller-crossdrive.exe" /S /KEEP_APP_DATA $4 _?=$3' $R0
          ${endif}
          Delete "$PLUGINSDIR\old-uninstaller-crossdrive.exe"
        ${endif}
      ${endif}
    ${endif}

    Pop $R2
    Pop $R1
    Pop $R0
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  !macroend

  !macro customCheckAppRunning
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
    !insertmacro quixoticPreUninstallCrossDrive SHELL_CONTEXT
    ${if} $installMode == "all"
      !insertmacro quixoticPreUninstallCrossDrive HKEY_CURRENT_USER
    ${endif}
  !macroend
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
  !ifndef BUILD_UNINSTALLER
    StrCpy $t3AppWasRunning 1
  !endif
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

  # The template relaunches after a silent install only with --force-run, which WinGet does not pass.
  ${If} ${Silent}
  ${AndIfNot} ${isForceRun}
  ${AndIf} $t3AppWasRunning == 1
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  ${EndIf}
!macroend
