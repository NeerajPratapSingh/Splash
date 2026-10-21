; Uninstall: if Splash was the default file manager, hand folders, drives and
; Win+E back to Windows Explorer, so nothing is left pointing at a removed app.
!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $0 HKCU "Software\Classes\Directory\shell" ""
  StrCmp $0 "Splash.Open" 0 +2
    DeleteRegValue HKCU "Software\Classes\Directory\shell" ""
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Splash.Open"

  ReadRegStr $0 HKCU "Software\Classes\Drive\shell" ""
  StrCmp $0 "Splash.Open" 0 +2
    DeleteRegValue HKCU "Software\Classes\Drive\shell" ""
  DeleteRegKey HKCU "Software\Classes\Drive\shell\Splash.Open"

  ReadRegStr $0 HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}" "SplashOwner"
  StrCmp $0 "1" 0 +2
    DeleteRegKey HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}"
!macroend
