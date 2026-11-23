package main

import "github.com/getlantern/systray"

// AppIndicator falls back to an X11 tray when Cinnamon has no StatusNotifierWatcher.
var (
	runTray     = systray.Run
	setTrayIcon = systray.SetIcon
	addMenuItem = systray.AddMenuItem
	quitTray    = systray.Quit
)
