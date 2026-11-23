package main

import (
	_ "embed"
	"image"
	"image/color"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

//go:embed assets/cute-claw-normal.png
var clawNormal []byte

//go:embed assets/cute-claw-username.png
var clawUsername []byte

//go:embed assets/cute-claw-password.png
var clawPassword []byte

const (
	clawWidth = 120
	clawLift  = 7
	clawPeek  = 82
)

type claw struct {
	*canvas.Image
	typing   bool
	pointing bool
}

func newClaw() *claw {
	c := &claw{Image: canvas.NewImageFromResource(nil)}
	c.FillMode = canvas.ImageFillContain
	c.SetMinSize(fyne.NewSquareSize(clawWidth))
	c.paint()
	return c
}

func (c *claw) setTyping(typing bool) {
	c.typing = typing
	c.paint()
}

func (c *claw) setPointing(pointing bool) {
	c.pointing = pointing
	c.paint()
}

func (c *claw) paint() {
	if c.pointing {
		c.Resource = fyne.NewStaticResource("cute-claw-username.png", clawUsername)
	} else if c.typing {
		c.Resource = fyne.NewStaticResource("cute-claw-password.png", clawPassword)
	} else {
		c.Resource = fyne.NewStaticResource("cute-claw-normal.png", clawNormal)
	}
	c.Refresh()
}

type peek struct{}

func (peek) Layout(objects []fyne.CanvasObject, size fyne.Size) {
	clawX := size.Width*0.7 - clawWidth/2
	objects[0].Resize(fyne.NewSize(size.Width, objects[0].MinSize().Height))
	objects[0].Move(fyne.NewPos(0, clawPeek+clawLift))
	objects[1].Resize(objects[1].MinSize())
	objects[1].Move(fyne.NewPos(clawX, clawLift))
	objects[2].Resize(fyne.NewSize(clawX+8, 0))
	height := objects[2].MinSize().Height
	objects[2].Resize(fyne.NewSize(clawX+8, height))
	objects[2].Move(fyne.NewPos(0, max(0, clawPeek-4-height)))
}

func (peek) MinSize(objects []fyne.CanvasObject) fyne.Size {
	return fyne.NewSize(objects[0].MinSize().Width, clawPeek+clawLift+objects[0].MinSize().Height)
}

type codeEntry struct {
	widget.Entry
	onFocus func(bool)
}

func newCodeEntry(onFocus func(bool)) *codeEntry {
	e := &codeEntry{onFocus: onFocus}
	e.Password = true
	e.ExtendBaseWidget(e)
	return e
}

func (e *codeEntry) FocusGained() {
	e.Entry.FocusGained()
	e.onFocus(true)
}

func (e *codeEntry) FocusLost() {
	e.Entry.FocusLost()
	e.onFocus(false)
}

type hoverButton struct {
	widget.Button
	onHover func(bool)
}

func newHoverButton(label string, icon fyne.Resource, tapped func(), onHover func(bool)) *hoverButton {
	b := &hoverButton{onHover: onHover}
	b.Text, b.Icon, b.OnTapped = label, icon, tapped
	b.ExtendBaseWidget(b)
	return b
}

func (b *hoverButton) Cursor() desktop.Cursor {
	if b.Disabled() {
		return desktop.DefaultCursor
	}
	return desktop.PointerCursor
}

func (b *hoverButton) MouseIn(e *desktop.MouseEvent) {
	b.Button.MouseIn(e)
	b.onHover(true)
}

func (b *hoverButton) MouseOut() {
	b.Button.MouseOut()
	b.onHover(false)
}

func bubble(text string) fyne.CanvasObject {
	const px = 4
	shape := canvas.NewRaster(func(width, height int) image.Image {
		w, h := width/px-3, height/px
		mid := h/2 - 1
		cells := image.NewNRGBA(image.Rect(0, 0, w+3, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				if (x == 0 || x == w-1) && (y == 0 || y == h-1) {
					continue
				} else if x == 0 || x == w-1 || y == 0 || y == h-1 {
					cells.Set(x, y, ink)
				} else {
					cells.Set(x, y, color.White)
				}
			}
		}
		for i, row := range []string{"ik", "wwk", "wwwk", "wwk", "ik"} {
			for j, c := range row {
				if c == 'k' {
					cells.Set(w-1+j, mid-2+i, ink)
				} else if c == 'w' {
					cells.Set(w-1+j, mid-2+i, color.White)
				}
			}
		}
		return cells
	})
	shape.ScaleMode = canvas.ImageScalePixels
	label := widget.NewLabel(text)
	label.Wrapping = fyne.TextWrapWord
	return container.NewStack(shape, container.NewBorder(nil, nil, nil, blank(3*px, 0), label))
}

func blank(width, height float32) fyne.CanvasObject {
	gap := canvas.NewRectangle(color.Transparent)
	gap.SetMinSize(fyne.NewSize(width, height))
	return gap
}

func footerGap() fyne.CanvasObject {
	const footerPaddingUnits = 4
	return blank(0, footerPaddingUnits*theme.Padding())
}

func step(number string, text string) fyne.CanvasObject {
	circle := canvas.NewCircle(theme.Color(theme.ColorNamePrimary))
	digit := canvas.NewText(number, theme.Color(theme.ColorNameForegroundOnPrimary))
	digit.TextStyle.Bold = true
	badge := container.NewGridWrap(
		fyne.NewSquareSize(22),
		container.NewStack(circle, container.NewCenter(digit)),
	)
	label := canvas.NewText(text, theme.Color(theme.ColorNameForeground))
	label.TextStyle.Bold = true
	return container.NewHBox(container.NewCenter(badge), container.NewCenter(label))
}

func card(content fyne.CanvasObject) fyne.CanvasObject {
	glass := canvas.NewRectangle(color.NRGBA{0xff, 0xff, 0xff, 0xb3})
	glass.CornerRadius = 18
	glass.Shadow = canvas.Shadow{
		Color:      color.NRGBA{0, 0, 0, 0x33},
		BlurRadius: 35,
		Offset:     fyne.NewPos(0, 15),
		Variant:    canvas.DropShadow,
	}
	return container.NewStack(glass, container.NewPadded(container.NewPadded(content)))
}
