!ifndef BUILD_UNINSTALLER
Var VBCableSetupPath
Var VBCableSetupDir
Var VBCableInfPath
Var VBCableSearchRoot
Var VBCableZipPath
Var VBCableLogPath
Var VBCableFindHandle
Var VBCableFindName
Var VBCableFindDir
Var VBCableUnzipResult
Var VBCableInstallResult
Var VBCableCommandOutput
Var VBCableIncompleteFound
!endif

!macro customUnInstall
  Push $0
  DetailPrint "Removing freqx:// protocol registration..."
  DeleteRegKey SHCTX "Software\Classes\freqx"

  DetailPrint "Removing freqx app data..."

  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}

  RMDir /r "$APPDATA\freqx"
  RMDir /r "$APPDATA\freqx-dev"
  RMDir /r "$LOCALAPPDATA\freqx"
  RMDir /r "$LOCALAPPDATA\freqx-dev"

  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}

  ReadEnvStr $0 "ProgramData"
  StrCmp $0 "" +2
    RMDir /r "$0\freqx"
  Pop $0
!macroend

!macro customInstall
  DetailPrint "Registering freqx:// protocol handler..."
  WriteRegStr SHCTX "Software\Classes\freqx" "" "URL:freqx Protocol"
  WriteRegStr SHCTX "Software\Classes\freqx" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\freqx\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\freqx\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""

  Call PrepareVBCableSetup
  StrCmp $VBCableSetupPath "" vbcable_done

  Call FindVBCableInf
  StrCmp $VBCableInfPath "" vbcable_run_setup

  DetailPrint "Installing VB-CABLE silently from $VBCableSetupPath..."
  StrCpy $VBCableLogPath "$INSTDIR\vbcable-install.log"
  File /oname=$PLUGINSDIR\install-vbcable-driver.ps1 "${PROJECT_DIR}\installer\install-vbcable-driver.ps1"
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-vbcable-driver.ps1" -SetupPath "$VBCableSetupPath" -InfPath "$VBCableInfPath" -LogPath "$VBCableLogPath"`
  Pop $VBCableInstallResult
  Pop $VBCableCommandOutput
  StrCmp $VBCableInstallResult "0" vbcable_reboot_required
  StrCmp $VBCableInstallResult "3010" vbcable_reboot_required

  DetailPrint "VB-CABLE silent driver install failed with exit code $VBCableInstallResult."
  MessageBox MB_ICONEXCLAMATION|MB_YESNO "VB-CABLE silent driver installation failed with exit code $VBCableInstallResult.$\n$\nLog: $VBCableLogPath$\n$\nRun the official VB-CABLE setup window as a fallback?" IDYES vbcable_run_setup IDNO vbcable_done

  vbcable_run_setup:
  DetailPrint "Running VB-CABLE setup from $VBCableSetupDir..."
  SetOutPath "$VBCableSetupDir"
  ExecWait '"$VBCableSetupPath"'
  SetOutPath "$INSTDIR"
  Goto vbcable_done

  vbcable_reboot_required:
  DetailPrint "VB-CABLE driver install completed and requires a reboot."
  SetRebootFlag true

  vbcable_done:
!macroend

!ifndef BUILD_UNINSTALLER
  Function PrepareVBCableSetup
    StrCpy $VBCableSetupPath ""
    StrCpy $VBCableSetupDir ""
    StrCpy $VBCableInfPath ""
    StrCpy $VBCableZipPath ""
    StrCpy $VBCableIncompleteFound "0"

    StrCpy $VBCableSearchRoot "$INSTDIR\resources\drivers"
    Call FindCompleteVBCableSetup
    StrCmp $VBCableSetupPath "" 0 vbcable_prepare_done

    Call FindVBCableZip
    StrCmp $VBCableZipPath "" 0 vbcable_extract_zip

    StrCmp $VBCableIncompleteFound "1" 0 vbcable_prepare_done
      DetailPrint "VB-CABLE setup was found without its companion driver files."
      MessageBox MB_ICONEXCLAMATION|MB_OK "VB-CABLE setup was found, but companion driver files are missing. Bundle the full official VB-CABLE zip or extract it into the drivers folder; copying only VBCABLE_Setup.exe is not enough."
      Return

    vbcable_extract_zip:
      DetailPrint "Extracting VB-CABLE driver package from $VBCableZipPath..."
      CreateDirectory "$PLUGINSDIR\vbcable"
      nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '$VBCableZipPath' -DestinationPath '$PLUGINSDIR\vbcable' -Force"`
      Pop $VBCableUnzipResult
      Pop $VBCableCommandOutput
      StrCmp $VBCableUnzipResult "0" 0 vbcable_unzip_failed

      StrCpy $VBCableSearchRoot "$PLUGINSDIR\vbcable"
      Call FindCompleteVBCableSetup
      StrCmp $VBCableSetupPath "" 0 vbcable_prepare_done

      DetailPrint "VB-CABLE zip was extracted, but a complete driver package was not found."
      MessageBox MB_ICONEXCLAMATION|MB_OK "VB-CABLE zip was extracted, but the installer could not find VBCABLE_Setup.exe with its companion .inf and .sys files."
      Return

    vbcable_unzip_failed:
      DetailPrint "VB-CABLE zip extraction failed: $VBCableUnzipResult"
      MessageBox MB_ICONEXCLAMATION|MB_OK "VB-CABLE zip extraction failed with exit code $VBCableUnzipResult."

    vbcable_prepare_done:
  FunctionEnd

  Function FindCompleteVBCableSetup
    StrCpy $VBCableSetupPath ""
    StrCpy $VBCableSetupDir ""

    IfFileExists "$VBCableSearchRoot\VBCABLE_Setup_x64.exe" 0 vbcable_find_root_x86
      StrCpy $VBCableIncompleteFound "1"
      IfFileExists "$VBCableSearchRoot\*.inf" 0 vbcable_find_root_x86
      IfFileExists "$VBCableSearchRoot\*.sys" 0 vbcable_find_root_x86
      StrCpy $VBCableSetupPath "$VBCableSearchRoot\VBCABLE_Setup_x64.exe"
      StrCpy $VBCableSetupDir "$VBCableSearchRoot"
      Return

    vbcable_find_root_x86:
      IfFileExists "$VBCableSearchRoot\VBCABLE_Setup.exe" 0 vbcable_find_nested
        StrCpy $VBCableIncompleteFound "1"
        IfFileExists "$VBCableSearchRoot\*.inf" 0 vbcable_find_nested
        IfFileExists "$VBCableSearchRoot\*.sys" 0 vbcable_find_nested
        StrCpy $VBCableSetupPath "$VBCableSearchRoot\VBCABLE_Setup.exe"
        StrCpy $VBCableSetupDir "$VBCableSearchRoot"
        Return

    vbcable_find_nested:
      FindFirst $VBCableFindHandle $VBCableFindName "$VBCableSearchRoot\*"
      IfErrors vbcable_find_done

    vbcable_find_loop:
      StrCmp $VBCableFindName "." vbcable_find_next
      StrCmp $VBCableFindName ".." vbcable_find_next
      IfFileExists "$VBCableSearchRoot\$VBCableFindName\*.*" 0 vbcable_find_next

      IfFileExists "$VBCableSearchRoot\$VBCableFindName\VBCABLE_Setup_x64.exe" 0 vbcable_find_nested_x86
        StrCpy $VBCableIncompleteFound "1"
        IfFileExists "$VBCableSearchRoot\$VBCableFindName\*.inf" 0 vbcable_find_nested_x86
        IfFileExists "$VBCableSearchRoot\$VBCableFindName\*.sys" 0 vbcable_find_nested_x86
        StrCpy $VBCableSetupPath "$VBCableSearchRoot\$VBCableFindName\VBCABLE_Setup_x64.exe"
        StrCpy $VBCableSetupDir "$VBCableSearchRoot\$VBCableFindName"
        Goto vbcable_find_close

      vbcable_find_nested_x86:
        IfFileExists "$VBCableSearchRoot\$VBCableFindName\VBCABLE_Setup.exe" 0 vbcable_find_next
          StrCpy $VBCableIncompleteFound "1"
          IfFileExists "$VBCableSearchRoot\$VBCableFindName\*.inf" 0 vbcable_find_next
          IfFileExists "$VBCableSearchRoot\$VBCableFindName\*.sys" 0 vbcable_find_next
          StrCpy $VBCableSetupPath "$VBCableSearchRoot\$VBCableFindName\VBCABLE_Setup.exe"
          StrCpy $VBCableSetupDir "$VBCableSearchRoot\$VBCableFindName"
          Goto vbcable_find_close

    vbcable_find_next:
      FindNext $VBCableFindHandle $VBCableFindName
      IfErrors vbcable_find_close
      Goto vbcable_find_loop

    vbcable_find_close:
      FindClose $VBCableFindHandle

    vbcable_find_done:
  FunctionEnd

  Function FindVBCableZip
    StrCpy $VBCableZipPath ""

    FindFirst $VBCableFindHandle $VBCableFindName "$INSTDIR\resources\drivers\*.zip"
    IfErrors vbcable_zip_nested
      StrCpy $VBCableZipPath "$INSTDIR\resources\drivers\$VBCableFindName"
      Goto vbcable_zip_close

    vbcable_zip_nested:
      FindFirst $VBCableFindHandle $VBCableFindName "$INSTDIR\resources\drivers\*"
      IfErrors vbcable_zip_done

    vbcable_zip_loop:
      StrCmp $VBCableFindName "." vbcable_zip_next
      StrCmp $VBCableFindName ".." vbcable_zip_next
      IfFileExists "$INSTDIR\resources\drivers\$VBCableFindName\*.*" 0 vbcable_zip_next
      IfFileExists "$INSTDIR\resources\drivers\$VBCableFindName\*.zip" 0 vbcable_zip_next

      StrCpy $VBCableFindDir "$VBCableFindName"
      FindClose $VBCableFindHandle
      FindFirst $VBCableFindHandle $VBCableFindName "$INSTDIR\resources\drivers\$VBCableFindDir\*.zip"
      IfErrors vbcable_zip_done
      StrCpy $VBCableZipPath "$INSTDIR\resources\drivers\$VBCableFindDir\$VBCableFindName"
      Goto vbcable_zip_close

    vbcable_zip_next:
      FindNext $VBCableFindHandle $VBCableFindName
      IfErrors vbcable_zip_close
      Goto vbcable_zip_loop

    vbcable_zip_close:
      FindClose $VBCableFindHandle

    vbcable_zip_done:
  FunctionEnd

  Function FindVBCableInf
    StrCpy $VBCableInfPath ""

    IfFileExists "$VBCableSetupDir\vbMmeCable64_win10.inf" 0 vbcable_inf_x64_win7
      StrCpy $VBCableInfPath "$VBCableSetupDir\vbMmeCable64_win10.inf"
      Return

    vbcable_inf_x64_win7:
      IfFileExists "$VBCableSetupDir\vbMmeCable64_win7.inf" 0 vbcable_inf_x86_win7
        StrCpy $VBCableInfPath "$VBCableSetupDir\vbMmeCable64_win7.inf"
        Return

    vbcable_inf_x86_win7:
      IfFileExists "$VBCableSetupDir\vbMmeCable_win7.inf" 0 vbcable_inf_any
        StrCpy $VBCableInfPath "$VBCableSetupDir\vbMmeCable_win7.inf"
        Return

    vbcable_inf_any:
      FindFirst $VBCableFindHandle $VBCableFindName "$VBCableSetupDir\*.inf"
      IfErrors vbcable_inf_done
        StrCpy $VBCableInfPath "$VBCableSetupDir\$VBCableFindName"
        FindClose $VBCableFindHandle

    vbcable_inf_done:
  FunctionEnd
!endif
