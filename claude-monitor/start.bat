@echo off
title Claude Code Monitor

:: Disable Quick Edit mode to prevent console selection from freezing the process
:: This MUST be done via PowerShell before launching Node.js
powershell -NoProfile -Command "
  Add-Type -Name ConsoleHelper -Namespace Win32 -MemberDefinition '
    [DllImport(\"kernel32.dll\", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport(\"kernel32.dll\", SetLastError = true)]
    public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
    [DllImport(\"kernel32.dll\", SetLastError = true)]
    public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
  ';
  $handle = [Win32.ConsoleHelper]::GetStdHandle(-10); # STD_INPUT_HANDLE
  $mode = 0;
  [Win32.ConsoleHelper]::GetConsoleMode($handle, [ref]$mode);
  # ENABLE_EXTENDED_FLAGS | ENABLE_INSERT_MODE | ENABLE_LINE_INPUT | ENABLE_MOUSE_INPUT | ENABLE_PROCESSED_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT
  # Remove: ENABLE_QUICK_EDIT_MODE (0x0040) & ENABLE_AUTO_POSITION (0x0100) & ENABLE_ECHO_INPUT (0x0004)
  $mode = $mode -band -bnot 0x0040;
  $mode = $mode -band -bnot 0x0100;
  $mode = $mode -band -bnot 0x0004;
  [Win32.ConsoleHelper]::SetConsoleMode($handle, $mode);
" >nul 2>&1

echo Starting Claude Code Monitor...
echo.

call npx electron .
