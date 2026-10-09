# Inject only into the caller's controlled test window, then restore Num Lock.
param([int]$ScanCode=79,[switch]$Extended,[ValidateSet('on','off','keep')][string]$NumLock='keep',[switch]$Control,[switch]$Shift,[int]$RepeatDown=1,[long]$WindowHandle=0)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class FreqxTestInput {
  static IntPtr ExpectedWindow;
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk,wScan; public uint dwFlags,time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint n,INPUT[] input,int size);
  [DllImport("user32.dll")] public static extern short GetKeyState(int key);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first,uint second,bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  public static void Foreground(IntPtr window) {
    ExpectedWindow=window;
    uint process;uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out process),current=GetCurrentThreadId();
    bool attached=foreground!=current && AttachThreadInput(current,foreground,true);
    try {BringWindowToTop(window);SetForegroundWindow(window);} finally {if(attached) AttachThreadInput(current,foreground,false);}
  }
  public static void Key(ushort scan,uint flags) {
    if((flags&2)==0 && GetForegroundWindow()!=ExpectedWindow) throw new Exception("Controlled window lost foreground; no key down was sent");
    var input=new INPUT { type=1,u=new INPUTUNION {ki=new KEYBDINPUT {wScan=scan,dwFlags=flags|8}}};
    if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("SendInput failed: "+Marshal.GetLastWin32Error());
    Thread.Sleep(30);
  }
  public static void Tap(ushort scan,uint flags) {Key(scan,flags);Key(scan,flags|2);}
  public static void ToggleNumLock() {
    foreach(uint flags in new uint[]{1,3}) {
      var input=new INPUT { type=1,u=new INPUTUNION {ki=new KEYBDINPUT {wVk=0x90,wScan=0x45,dwFlags=flags}}};
      if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("Num Lock SendInput failed");
      Thread.Sleep(30);
    }
  }
}
'@
$initialLock=([FreqxTestInput]::GetKeyState(0x90)-band 1)-ne 0
$desiredLock=if($NumLock-eq'keep'){$initialLock}else{$NumLock-eq'on'}
if($WindowHandle-le 0){throw 'A controlled foreground window handle is required.'}
[FreqxTestInput]::Foreground([IntPtr]::new($WindowHandle))
Start-Sleep -Milliseconds 100
if([FreqxTestInput]::GetForegroundWindow().ToInt64()-ne$WindowHandle){throw 'The controlled test window is not foreground; no input was sent.'}
$flags=if($Extended){1}else{0}
$keyDownAttempted=$false
try {
  if($initialLock-ne$desiredLock){[FreqxTestInput]::ToggleNumLock()}
  if($Control){[FreqxTestInput]::Key(0x1d,0)}
  if($Shift){[FreqxTestInput]::Key(0x2a,0)}
  for($i=0;$i-lt$RepeatDown;$i++){
    $keyDownAttempted=$true
    [FreqxTestInput]::Key([uint16]$ScanCode,[uint32]$flags)
  }
  [FreqxTestInput]::Key([uint16]$ScanCode,[uint32]($flags-bor 2))
  $keyDownAttempted=$false
  $inputState=[ordered]@{foreground=[FreqxTestInput]::GetForegroundWindow().ToInt64();numLock=([FreqxTestInput]::GetKeyState(0x90)-band 1)-ne 0;initialNumLock=$initialLock}
} finally {
  try {
    if($keyDownAttempted){[FreqxTestInput]::Key([uint16]$ScanCode,[uint32]($flags-bor 2))}
  } finally {
    try {if($Shift){[FreqxTestInput]::Key(0x2a,2)}} finally {
      try {if($Control){[FreqxTestInput]::Key(0x1d,2)}} finally {
        if($initialLock-ne$desiredLock){[FreqxTestInput]::ToggleNumLock()}
      }
    }
  }
}
$inputState.restoredNumLock=([FreqxTestInput]::GetKeyState(0x90)-band 1)-ne 0
$inputState | ConvertTo-Json -Compress
