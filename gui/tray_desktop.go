//go:build !linux

package main

import "fyne.io/systray"

// Windows and macOS share Fyne's tray backend. Linking both backends on macOS
// produces duplicate native symbols.
var (
	runTray     = systray.Run
	setTrayIcon = systray.SetIcon
	addMenuItem = systray.AddMenuItem
	quitTray    = systray.Quit
)
