package main

import (
	"bufio"
	"embed"
	"encoding/binary"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/lang"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
	"fyne.io/systray"
	"github.com/shirou/gopsutil/v4/process"
	"golang.org/x/text/language"
)

//go:embed translations
var translations embed.FS

var languages = []struct{ code, name string }{
	{"en", "English"},
	{"de", "Deutsch"},
	{"fr", "Français"},
	{"zh-CN", "简体中文"},
	{"zh-TW", "繁體中文"},
	{"ja", "日本語"},
	{"ko", "한국어"},
	{"es", "Español"},
	{"pt", "Português"},
}

func languageSelect(a fyne.App) *widget.Select {
	names := make([]string, len(languages))
	tags := make([]language.Tag, len(languages))
	for i, l := range languages {
		names[i] = l.name
		tags[i] = language.Make(l.code)
	}
	sel := widget.NewSelect(names, nil)
	_, current, _ := language.NewMatcher(tags).Match(language.Make(lang.SystemLocale().String()))
	sel.Selected = names[current]
	sel.OnChanged = func(string) { switchLanguage(a, languages[sel.SelectedIndex()].code) }
	return sel
}

func switchLanguage(a fyne.App, code string) {
	a.Preferences().SetString("language", code)
	os.Setenv("LANGUAGE", code)
	exe, err := os.Executable()
	if err != nil {
		panic(err)
	}
	if err := exec.Command(exe, os.Args[1:]...).Start(); err != nil {
		panic(err)
	}
	a.Quit()
}

func hc(args ...string) *exec.Cmd {
	return exec.Command(os.Args[2], append(os.Args[3:], args...)...)
}

func main() {
	if err := lang.AddTranslationsFS(translations, "translations"); err != nil {
		panic(err)
	}
	if len(os.Args) > 1 && os.Args[1] == "login" {
		for _, p := range others(true) {
			p.Kill()
		}
		login()
	} else if len(others(false)) > 0 {
		show()
	} else {
		systray.Run(onReady, nil)
	}
}

func others(window bool) []*process.Process {
	exe, err := os.Executable()
	if err != nil {
		panic(err)
	}
	processes, err := process.Processes()
	if err != nil {
		panic(err)
	}
	var found []*process.Process
	for _, p := range processes {
		name, _ := p.Name()
		args, _ := p.CmdlineSlice()
		isWindow := len(args) > 1 && args[1] == "login"
		if name == filepath.Base(exe) && p.Pid != int32(os.Getpid()) && isWindow == window {
			found = append(found, p)
		}
	}
	return found
}

func show() {
	exe, err := os.Executable()
	if err != nil {
		panic(err)
	}
	cmd := exec.Command(exe, append([]string{"login"}, os.Args[1:]...)...)
	if err := cmd.Start(); err != nil {
		panic(err)
	}
	go cmd.Wait()
}

func trayIcon() []byte {
	if runtime.GOOS != "windows" {
		return clawNormal
	}
	header := []byte{0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0}
	binary.LittleEndian.PutUint32(header[14:], uint32(len(clawNormal)))
	return append(header, clawNormal...)
}

func onReady() {
	systray.SetIcon(trayIcon())
	open := systray.AddMenuItem("HighClaws", "")
	quit := systray.AddMenuItem(lang.L("Quit"), "")
	show()
	go func() {
		for range open.ClickedCh {
			show()
		}
	}()
	go func() {
		<-quit.ClickedCh
		systray.Quit()
	}()
}

func login() {
	a := app.NewWithID("hc.gui")
	if code := a.Preferences().String("language"); code != "" {
		os.Setenv("LANGUAGE", code)
		if err := lang.AddTranslationsFS(translations, "translations"); err != nil {
			panic(err)
		}
	}
	a.Settings().SetTheme(loginTheme{theme.DefaultTheme()})
	a.SetIcon(fyne.NewStaticResource("cute-claw-normal.png", clawNormal))
	w := a.NewWindow("HighClaws")
	w.SetFixedSize(true)
	sandboxes := newSandboxList(w)
	mascot := newClaw()
	code := newCodeEntry(mascot.setTyping)
	code.SetPlaceHolder(lang.L("Login code"))
	failure := widget.NewLabel("")
	failure.Importance = widget.DangerImportance
	failure.Hide()
	var stdin io.WriteCloser
	var link *url.URL
	open := newHoverButton(lang.L("Open Browser"), theme.LoginIcon(), func() { a.OpenURL(link) }, mascot.setPointing)
	open.Importance = widget.HighImportance
	open.Disable()
	submit := widget.NewButton(lang.L("Login"), nil)
	submit.Importance = widget.HighImportance
	submit.Disable()

	var start func()
	start = func() {
		cmd := hc("auth", "login")
		var err error
		stdin, err = cmd.StdinPipe()
		if err != nil {
			panic(err)
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			panic(err)
		}
		if err := cmd.Start(); err != nil {
			panic(err)
		}
		go func() {
			lines := bufio.NewScanner(stdout)
			for lines.Scan() {
				if found, err := url.Parse(lines.Text()); err == nil && found.Scheme == "https" {
					fyne.Do(func() {
						link = found
						open.Enable()
					})
				}
			}
			err := cmd.Wait()
			fyne.Do(func() {
				if err == nil {
					sandboxes.load(1, nil)
				} else {
					failure.SetText(lang.L("Login failed. Please try again."))
					submit.SetText(lang.L("Login"))
					failure.Show()
					code.SetText("")
					code.Enable()
					start()
				}
			})
		}()
	}

	submit.OnTapped = func() {
		submit.Disable()
		submit.SetText(lang.L("Logging in…"))
		code.Disable()
		failure.Hide()
		if _, err := io.WriteString(stdin, code.Text+"\n"); err != nil {
			panic(err)
		}
		stdin.Close()
	}
	code.OnChanged = func(text string) {
		if text == "" {
			submit.Disable()
		} else {
			submit.Enable()
		}
	}
	code.OnSubmitted = func(string) {
		if !submit.Disabled() {
			submit.OnTapped()
		}
	}

	form := container.NewVBox(
		blank(0, 8),
		step("1", lang.L("Sign in on the web page")),
		container.NewCenter(container.NewThemeOverride(open, loginActionTheme{a.Settings().Theme()})),
		blank(0, 16),
		step("2", lang.L("Paste the login code it shows")),
		container.NewBorder(nil, nil, nil, submit, code),
		failure,
		footerGap(),
		container.NewCenter(languageSelect(a)),
		blank(0, 8),
	)
	w.Resize(fyne.NewSize(380, 0))
	sandboxes.showLogin = func() {
		code.SetText("")
		code.Enable()
		submit.SetText(lang.L("Login"))
		failure.Hide()
		w.SetPadded(true)
		w.SetContent(container.NewPadded(container.New(
			peek{mascot},
			card(form),
			mascot.Image,
			bubble(lang.L("Welcome! I will help you connect to your sandbox.")),
		)))
		start()
	}
	sandboxes.load(1, sandboxes.showLogin)
	w.ShowAndRun()
}
