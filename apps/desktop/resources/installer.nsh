; 引导安装器的目录修正。electron-builder 自带的 instFilesPre 只检查路径里是否
; 出现过 APP_FILENAME（区分大小写）：选 D:\NekroNxt-backup 会直接装进这个已有
; 目录，卸载时 RMDir /r 会连同里面原有的文件一起删掉。这里在目录页之后、
; instFilesPre 之前把路径规整为“最后一级目录就是 APP_FILENAME”，模板的检查随之
; 必然通过，不再起作用。
!macro customPageAfterChangeDir
  Page custom ensureAppInstallDir

  Function ensureAppInstallDir
    ; 升级沿用注册表里的旧目录，不做改动，否则可能和旧安装分家。
    ${if} ${isUpdated}
      Return
    ${endif}

    Push $0
    Push $1

    ; 去掉末尾的反斜杠，D:\ 会变成 D:，随后补成 D:\NekroNxt。
    ${Do}
      StrCpy $0 $INSTDIR 1 -1
      ${If} $0 != "\"
        ${ExitDo}
      ${EndIf}
      StrCpy $INSTDIR $INSTDIR -1
    ${Loop}

    ${GetFileName} $INSTDIR $0
    ; StrCmp 不区分大小写；Windows 路径也不区分，改成标准大小写仍指向同一个目录，
    ; 也能让模板里区分大小写的检查通过，不会再套一层。
    ${If} $0 == "${APP_FILENAME}"
      StrLen $1 $0
      StrCpy $INSTDIR $INSTDIR -$1
      StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
    ${Else}
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}

    Pop $1
    Pop $0
  FunctionEnd
!macroend

; 完成页勾选“运行”时，模板用 StdUtils.ExecShellAsUser 同步启动应用：它要等资源管理器
; 那边的 ShellExecute 返回，未签名的大体积 exe 首次启动会先被扫描，这段时间安装窗口
; 显示“未响应”。改由 explorer.exe 打开快捷方式：Exec 不等待，应用仍以资源管理器的
; 普通权限启动，不会继承所有用户安装时的管理员权限。
!macro customFinishPage
  Function StartApp
    Exec '"$WINDIR\explorer.exe" "$launchLink"'
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
