; Extra steps for the SmartExplorer installer (picked up by electron-builder
; through package.json > build > nsis > include).
;
; Photo search runs on PyTorch, which needs Microsoft's Visual C++ runtime
; (14.x, 64-bit). Most Windows PCs already have it; a freshly installed one may
; not, and without it the app starts but photo search can't load. So the
; installer carries Microsoft's own redistributable and installs it, silently,
; only when the machine lacks a recent enough copy.

!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Bld"
  SetRegView lastused

  ; Not installed at all -> install. Installed -> only if older than build 31000.
  IntCmp $0 1 vcCheckBuild vcNeedRuntime vcNeedRuntime
  vcCheckBuild:
    IntCmp $1 31000 vcRuntimeDone vcNeedRuntime vcRuntimeDone
  vcNeedRuntime:
    DetailPrint "Installing the Microsoft Visual C++ runtime (needed for photo search)..."
    ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart' $2
    DetailPrint "Visual C++ runtime installer finished (code $2)"
  vcRuntimeDone:
  Delete "$INSTDIR\resources\vc_redist.x64.exe"
!macroend
