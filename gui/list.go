package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/color"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/lang"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

const pageSize = 3

var boxIcon = theme.NewThemedResource(fyne.NewStaticResource("box.svg", []byte(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.2 6.6 3.3L12 10.8 5.4 7.5 12 4.2zM5 9.1l6 3v7.6l-6-3V9.1zm8 10.6v-7.6l6-3v7.6l-6 3z"/></svg>`,
)))

var linkIcon = svgIcon("link.svg", "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5zM8 13h8v-2H8v2z")

var unlinkIcon = svgIcon("unlink.svg", "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5zM4.3 2.9 2.9 4.3l16.8 16.8 1.4-1.4z")

func svgIcon(name, path string) fyne.Resource {
	return theme.NewThemedResource(fyne.NewStaticResource(name, []byte(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="`+path+`"/></svg>`,
	)))
}

type sandbox struct {
	ProvisionID any    `json:"provision_id"`
	Name        string `json:"name"`
	Clients     []struct {
		Name      string `json:"name"`
		Connected bool   `json:"connected"`
	}
	ClientsErr error
}

type sandboxList struct {
	w         fyne.Window
	hc        []string
	page      int
	pages     int
	paints    []func()
	items     []sandbox
	connected map[[2]string]bool
	stopping  map[[2]string]bool
	rows      *fyne.Container
	label     *widget.Label
	prev      *widget.Button
	next      *widget.Button
	bar       *fyne.Container
	content   fyne.CanvasObject
	showLogin func()
}

func newSandboxList(w fyne.Window, hc []string) *sandboxList {
	l := &sandboxList{w: w, hc: hc, connected: map[[2]string]bool{}, stopping: map[[2]string]bool{}}
	l.rows = container.NewVBox()
	l.label = widget.NewLabel("")
	l.prev = widget.NewButtonWithIcon(lang.L("Previous"), theme.NavigateBackIcon(), func() { l.load(l.page-1, nil) })
	l.next = widget.NewButtonWithIcon(lang.L("Next"), theme.NavigateNextIcon(), func() { l.load(l.page+1, nil) })
	l.bar = container.NewCenter(container.NewHBox(l.prev, l.label, l.next))
	height := canvas.NewRectangle(color.Transparent)
	height.SetMinSize(fyne.NewSize(0, 300))
	logout := widget.NewHyperlink(lang.L("Log out"), nil)
	logout.SizeName = theme.SizeNameCaptionText
	logout.OnTapped = func() {
		go func() {
			if err := exec.Command(l.hc[0], append(l.hc[1:], "auth", "logout")...).Run(); err != nil {
				panic(err)
			}
			fyne.Do(func() { l.load(1, l.showLogin) })
		}()
	}
	bottom := container.New(layout.NewCustomPaddedVBoxLayout(0), spacer(16), l.bar, container.NewCenter(logout))
	surface := canvas.NewRectangle(color.NRGBA{0xff, 0xff, 0xff, 0xb3})
	l.content = container.NewStack(surface, container.NewPadded(container.NewPadded(
		container.NewBorder(nil, bottom, nil, nil, container.NewStack(height, l.rows)),
	)))
	go func() {
		for range time.Tick(3 * time.Second) {
			var items []sandbox
			fyne.DoAndWait(func() { items = slices.Clone(l.items) })
			l.fetchClients(items)
			fyne.Do(func() {
				l.setConnected(items)
				for _, paint := range l.paints {
					paint()
				}
			})
		}
	}()
	return l
}

func (l *sandboxList) hcJSON(out any, args ...string) error {
	data, err := exec.Command(l.hc[0], append(l.hc[1:], append(args, "--json")...)...).Output()
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(out)
}

func (l *sandboxList) placeholder(text string, importance widget.Importance) {
	label := widget.NewLabelWithStyle(text, fyne.TextAlignCenter, fyne.TextStyle{})
	label.Importance = importance
	l.rows.Objects = []fyne.CanvasObject{label}
	l.rows.Refresh()
	l.paints = nil
}

func (l *sandboxList) load(page int, failed func()) {
	l.prev.Disable()
	l.next.Disable()
	l.placeholder(lang.L("Loading…"), widget.MediumImportance)
	l.bar.Hide()
	l.w.SetPadded(false)
	l.w.SetContent(l.content)
	go func() {
		var result struct {
			Items        []sandbox `json:"items"`
			TotalRecords int       `json:"total_records"`
		}
		err := l.hcJSON(&result, "sandbox", "ls", "--limit", fmt.Sprint(pageSize), "--page", fmt.Sprint(page))
		l.fetchClients(result.Items)
		fyne.Do(func() {
			if err != nil && failed != nil {
				failed()
			} else if err != nil {
				l.rows.Objects = []fyne.CanvasObject{l.retryRow(lang.L("Failed to load sandboxes."), page)}
				l.rows.Refresh()
			} else {
				l.bar.Show()
				l.page = page
				l.pages = max(1, (result.TotalRecords+pageSize-1)/pageSize)
				l.show(result.Items)
			}
		})
	}()
}

func (l *sandboxList) fetchClients(items []sandbox) {
	for i := range items {
		items[i].ClientsErr = l.hcJSON(&items[i], "sandbox", "ls-clients", fmt.Sprint(items[i].ProvisionID))
	}
}

func (l *sandboxList) setConnected(items []sandbox) {
	for _, s := range items {
		for _, client := range s.Clients {
			l.connected[[2]string{s.Name, client.Name}] = client.Connected
		}
	}
}

func (l *sandboxList) show(sandboxes []sandbox) {
	l.items = sandboxes
	l.setConnected(sandboxes)
	l.placeholder(lang.L("No sandboxes yet."), widget.MediumImportance)
	if len(sandboxes) > 0 {
		l.rows.RemoveAll()
	}
	for _, s := range sandboxes {
		name := widget.NewLabelWithStyle(s.Name, fyne.TextAlignLeading, fyne.TextStyle{Bold: true})
		name.SizeName = theme.SizeNameHeadingText
		l.rows.Add(container.NewHBox(widget.NewIcon(boxIcon), name))
		if s.ClientsErr != nil {
			l.rows.Add(indented(l.retryRow(lang.L("Failed to load tunnels."), l.page)))
		} else if len(s.Clients) == 0 {
			none := widget.NewLabel(lang.L("No tunnels yet."))
			none.Importance = widget.LowImportance
			l.rows.Add(indented(none))
		}
		for _, client := range s.Clients {
			l.rows.Add(l.tunnelRow(s.Name, client.Name))
		}
	}
	l.label.SetText(fmt.Sprintf("%d / %d", l.page, l.pages))
	if l.page > 1 {
		l.prev.Enable()
	}
	if l.page < l.pages {
		l.next.Enable()
	}
}

func (l *sandboxList) tunnelRow(sandboxName, tunnel string) fyne.CanvasObject {
	key := [2]string{sandboxName, tunnel}
	toggle := widget.NewButton("", nil)
	paint := func() {
		pid := tunnelPID(sandboxName, tunnel)
		if l.stopping[key] && (pid != 0 || l.connected[key]) {
			toggle.SetText(lang.L("Disconnecting…"))
			toggle.SetIcon(theme.ViewRefreshIcon())
			toggle.Importance = widget.MediumImportance
			toggle.Disable()
			return
		}
		delete(l.stopping, key)
		toggle.Enable()
		if pid == 0 {
			toggle.SetText(lang.L("Connect"))
			toggle.SetIcon(linkIcon)
			toggle.Importance = widget.MediumImportance
		} else if !l.connected[key] {
			toggle.SetText(lang.L("Connecting…"))
			toggle.SetIcon(theme.ViewRefreshIcon())
			toggle.Importance = widget.MediumImportance
		} else {
			toggle.SetText(lang.L("Disconnect"))
			toggle.SetIcon(unlinkIcon)
			toggle.Importance = widget.DangerImportance
		}
		toggle.Refresh()
	}
	toggle.OnTapped = func() {
		if pid := tunnelPID(sandboxName, tunnel); pid != 0 {
			l.stopping[key] = true
			syscall.Kill(pid, syscall.SIGTERM)
		} else {
			cmd := exec.Command(l.hc[0], append(l.hc[1:], "safe-expose", sandboxName, tunnel)...)
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			if err := cmd.Start(); err != nil {
				panic(err)
			}
			go cmd.Wait()
		}
		paint()
	}
	paint()
	l.paints = append(l.paints, paint)
	name := widget.NewLabelWithStyle(tunnel, fyne.TextAlignLeading, fyne.TextStyle{Bold: true})
	name.SizeName = theme.SizeNameSubHeadingText
	name.Importance = widget.HighImportance
	row := container.NewBorder(nil, nil, nil, toggle, name)
	return indented(pill(row))
}

func indented(content fyne.CanvasObject) fyne.CanvasObject {
	indent := canvas.NewRectangle(color.Transparent)
	indent.SetMinSize(fyne.NewSize(18, 0))
	return container.NewBorder(nil, nil, indent, nil, content)
}

func (l *sandboxList) retryRow(text string, page int) fyne.CanvasObject {
	failure := widget.NewLabel(text)
	failure.Importance = widget.DangerImportance
	retry := widget.NewHyperlink(lang.L("Retry"), nil)
	retry.OnTapped = func() { l.load(page, nil) }
	return container.NewHBox(failure, retry)
}

func tunnelPID(sandboxName, tunnel string) int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		panic(err)
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		cmdline, err := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		if err != nil {
			continue
		}
		args := strings.Split(strings.TrimSuffix(string(cmdline), "\x00"), "\x00")
		n := len(args)
		if n >= 3 && args[n-3] == "safe-expose" && args[n-2] == sandboxName && args[n-1] == tunnel {
			return pid
		}
	}
	return 0
}

func pill(content fyne.CanvasObject) fyne.CanvasObject {
	border := canvas.NewRectangle(color.White)
	border.StrokeColor = color.NRGBA{0x06, 0xb6, 0xd4, 0xff}
	border.StrokeWidth = 2
	border.CornerRadius = 14
	return container.NewStack(border, container.NewPadded(content))
}
