package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/color"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/lang"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
	"github.com/shirou/gopsutil/v4/process"
)

const pageSize = 2

const chain = "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"

var boxIcon = svgIcon("box.svg", "M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.2 6.6 3.3L12 10.8 5.4 7.5 12 4.2zM5 9.1l6 3v7.6l-6-3V9.1zm8 10.6v-7.6l6-3v7.6l-6 3z")

var linkIcon = svgIcon("link.svg", chain+"M8 13h8v-2H8v2z")

var unlinkIcon = svgIcon("unlink.svg", chain+"M4.3 2.9 2.9 4.3l16.8 16.8 1.4-1.4z")

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
	w          fyne.Window
	page       int
	generation int
	stopping   map[[2]string]bool
	rows       *fyne.Container
	label      *widget.Label
	prev       *widget.Button
	next       *widget.Button
	bar        *fyne.Container
	content    fyne.CanvasObject
	showLogin  func()
}

func newSandboxList(w fyne.Window) *sandboxList {
	l := &sandboxList{w: w, stopping: map[[2]string]bool{}}
	l.rows = container.NewVBox()
	l.label = widget.NewLabelWithStyle("", fyne.TextAlignCenter, fyne.TextStyle{Bold: true})
	l.prev = widget.NewButtonWithIcon(lang.L("Previous"), theme.NavigateBackIcon(), func() { l.load(l.page-1, nil) })
	l.next = widget.NewButtonWithIcon(lang.L("Next"), theme.NavigateNextIcon(), func() { l.load(l.page+1, nil) })
	l.next.IconPlacement = widget.ButtonIconTrailingText
	l.bar = container.NewCenter(container.NewHBox(l.prev, l.label, l.next))
	logout := widget.NewHyperlink(lang.L("Log out"), nil)
	logout.SizeName = theme.SizeNameCaptionText
	logout.OnTapped = func() {
		go func() {
			if err := hc("auth", "logout").Run(); err != nil {
				panic(err)
			}
			fyne.Do(func() { l.load(1, l.showLogin) })
		}()
	}
	bottom := container.NewVBox(footerGap(), l.bar, container.NewCenter(logout))
	l.content = container.NewPadded(container.NewVBox(l.rows, bottom))
	go func() {
		for range time.Tick(3 * time.Second) {
			var page, generation int
			fyne.DoAndWait(func() {
				page, generation = l.page, l.generation
			})
			if page > 0 {
				l.fetchPage(page, generation, nil)
			}
		}
	}()
	return l
}

func hcJSON(out any, args ...string) error {
	data, err := hc(append(args, "--json")...).Output()
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(out)
}

func (l *sandboxList) placeholder(text string) {
	label := widget.NewLabelWithStyle(text, fyne.TextAlignCenter, fyne.TextStyle{})
	l.rows.Objects = []fyne.CanvasObject{label}
	l.rows.Refresh()
}

func (l *sandboxList) load(page int, failed func()) {
	l.generation++
	l.page = 0
	l.placeholder(lang.L("Loading…"))
	l.bar.Hide()
	l.w.SetPadded(false)
	l.w.SetContent(l.content)
	go l.fetchPage(page, l.generation, failed)
}

func (l *sandboxList) fetchPage(page, generation int, failed func()) {
	var result struct {
		Items        []sandbox `json:"items"`
		TotalRecords int       `json:"total_records"`
	}
	err := hcJSON(&result, "sandbox", "ls", "--limit", fmt.Sprint(pageSize), "--page", fmt.Sprint(page))
	for i := range result.Items {
		s := &result.Items[i]
		s.ClientsErr = hcJSON(s, "sandbox", "ls-clients", fmt.Sprint(s.ProvisionID))
	}
	fyne.DoAndWait(func() {
		if generation != l.generation || (err != nil && l.page > 0) {
			return
		}
		if err != nil && failed != nil {
			failed()
		} else if err != nil {
			l.rows.Objects = []fyne.CanvasObject{l.retryRow(lang.L("Failed to load sandboxes."), page)}
			l.rows.Refresh()
			l.fitHeight()
		} else {
			pages := max(1, (result.TotalRecords+pageSize-1)/pageSize)
			if page > pages {
				l.load(pages, nil)
			} else {
				l.page = page
				l.show(result.Items, pages)
			}
		}
	})
}

func (l *sandboxList) show(sandboxes []sandbox, pages int) {
	l.rows.RemoveAll()
	if len(sandboxes) == 0 {
		l.placeholder(lang.L("No sandboxes yet."))
	}
	for _, s := range sandboxes {
		name := widget.NewLabelWithStyle(s.Name, fyne.TextAlignLeading, fyne.TextStyle{Bold: true})
		name.SizeName = theme.SizeNameHeadingText
		l.rows.Add(container.NewHBox(widget.NewIcon(boxIcon), name))
		if s.ClientsErr != nil {
			l.rows.Add(indented(l.retryRow(lang.L("Failed to load tunnels."), l.page)))
		} else if len(s.Clients) == 0 {
			none := widget.NewLabel(lang.L("No tunnels yet."))
			l.rows.Add(indented(none))
		}
		for _, client := range s.Clients {
			l.rows.Add(l.tunnelRow(s.Name, client.Name, client.Connected))
		}
	}
	if pages > 1 {
		l.label.SetText(fmt.Sprintf("%d / %d", l.page, pages))
		l.bar.Show()
	} else {
		l.bar.Hide()
	}
	if l.page > 1 {
		l.prev.Enable()
	} else {
		l.prev.Disable()
	}
	if l.page < pages {
		l.next.Enable()
	} else {
		l.next.Disable()
	}
	l.fitHeight()
}

func (l *sandboxList) fitHeight() {
	size := l.w.Canvas().Size()
	height := l.content.MinSize().Height
	if size.Height != height {
		l.w.Resize(fyne.NewSize(size.Width, height))
	}
}

func (l *sandboxList) tunnelRow(sandboxName, tunnel string, connected bool) fyne.CanvasObject {
	key := [2]string{sandboxName, tunnel}
	toggle := widget.NewButton("", nil)
	paint := func() {
		running := tunnelProcess(sandboxName, tunnel) != nil
		if l.stopping[key] && (running || connected) {
			toggle.SetText(lang.L("Disconnecting…"))
			toggle.SetIcon(theme.ViewRefreshIcon())
			toggle.Importance = widget.MediumImportance
			toggle.Disable()
			return
		}
		delete(l.stopping, key)
		toggle.Enable()
		if !running {
			toggle.SetText(lang.L("Connect"))
			toggle.SetIcon(linkIcon)
			toggle.Importance = widget.MediumImportance
		} else if !connected {
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
		if p := tunnelProcess(sandboxName, tunnel); p != nil {
			l.stopping[key] = true
			stopTunnel(p)
		} else {
			cmd := hc("safe-expose", sandboxName, tunnel)
			if err := cmd.Start(); err != nil {
				panic(err)
			}
			go cmd.Wait()
		}
		paint()
	}
	paint()
	name := widget.NewLabel(tunnel)
	row := container.NewBorder(nil, nil, nil, toggle, name)
	return indented(pill(row))
}

func indented(content fyne.CanvasObject) fyne.CanvasObject {
	return container.NewBorder(nil, nil, blank(theme.IconInlineSize(), 0), nil, content)
}

func (l *sandboxList) retryRow(text string, page int) fyne.CanvasObject {
	failure := widget.NewLabel(text)
	failure.Importance = widget.DangerImportance
	retry := widget.NewHyperlink(lang.L("Retry"), nil)
	retry.OnTapped = func() { l.load(page, nil) }
	return container.NewHBox(failure, retry)
}

func tunnelProcess(sandboxName, tunnel string) *process.Process {
	processes, err := process.Processes()
	if err != nil {
		panic(err)
	}
	for _, p := range processes {
		args, err := p.CmdlineSlice()
		n := len(args)
		if err == nil && n >= 3 && args[n-3] == "safe-expose" && args[n-2] == sandboxName && args[n-1] == tunnel {
			return p
		}
	}
	return nil
}

func stopTunnel(p *process.Process) {
	children, _ := p.Children()
	p.Terminate()
	for _, child := range children {
		child.Terminate()
	}
}

func pill(content fyne.CanvasObject) fyne.CanvasObject {
	border := canvas.NewRectangle(color.White)
	border.StrokeColor = theme.Color(theme.ColorNameSeparator)
	border.StrokeWidth = theme.SeparatorThicknessSize()
	border.CornerRadius = 14
	return container.NewStack(border, container.NewPadded(content))
}
