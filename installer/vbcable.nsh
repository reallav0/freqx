!macro customInstall
  IfFileExists "$INSTDIR\resources\drivers\VBCABLE_Setup_x64.exe" vbcable_install_x64 vbcable_check_x86

  vbcable_install_x64:
    DetailPrint "Running VB-CABLE x64 installer..."
    ExecWait '"$INSTDIR\resources\drivers\VBCABLE_Setup_x64.exe"'
    Goto vbcable_done

  vbcable_check_x86:
    IfFileExists "$INSTDIR\resources\drivers\VBCABLE_Setup.exe" vbcable_install_x86 vbcable_done

  vbcable_install_x86:
    DetailPrint "Running VB-CABLE installer..."
    ExecWait '"$INSTDIR\resources\drivers\VBCABLE_Setup.exe"'
    Goto vbcable_done

  vbcable_done:
!macroend
