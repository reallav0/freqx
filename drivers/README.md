Place the full official VB-CABLE zip here if you have permission to bundle it.

The installer will extract the zip during install, temporarily trust the package
signer for the Windows driver prompt, and run the official setup in hidden
install mode. You can also extract the zip here before building. Do not copy
only the setup executable; VB-CABLE needs the companion driver files from the
same package, including `.inf`, `.sys`, and catalog files.

Supported package/setup filenames:

- *.zip
- VBCABLE_Setup_x64.exe
- VBCABLE_Setup.exe

The freqx NSIS installer will run the official setup silently first, and only
open the setup window as a fallback if silent installation fails.
Do not commit or distribute the VB-CABLE installer unless the VB-Audio license or
explicit permission allows redistribution.
