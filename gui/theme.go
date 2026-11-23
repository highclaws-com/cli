package main

import (
	"image/color"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/theme"
)

type loginTheme struct{ fyne.Theme }

var colors = map[fyne.ThemeColorName]color.Color{
	theme.ColorNamePrimary:         color.NRGBA{0x08, 0x91, 0xb2, 0xff},
	theme.ColorNameHyperlink:       color.NRGBA{0x0e, 0x74, 0x90, 0xff},
	theme.ColorNameFocus:           color.NRGBA{0x06, 0xb6, 0xd4, 0x66},
	theme.ColorNameHover:           color.NRGBA{0xff, 0xff, 0xff, 0x40},
	theme.ColorNameBackground:      color.NRGBA{0x7d, 0xd3, 0xfc, 0xff},
	theme.ColorNameForeground:      color.NRGBA{0x0f, 0x17, 0x2a, 0xff},
	theme.ColorNameInputBackground: color.White,
	theme.ColorNameButton:          color.NRGBA{0xe2, 0xe8, 0xf0, 0xff},
}

var sizes = map[fyne.ThemeSizeName]float32{
	theme.SizeNameButtonRadius:   20,
	theme.SizeNameInputRadius:    8,
	theme.SizeNamePadding:        8,
	theme.SizeNameInnerPadding:   10,
	theme.SizeNameCaptionText:    12,
	theme.SizeNameText:           14,
	theme.SizeNameSubHeadingText: 15,
	theme.SizeNameHeadingText:    17,
	theme.SizeNameInlineIcon:     18,
}

func (loginTheme) Color(name fyne.ThemeColorName, _ fyne.ThemeVariant) color.Color {
	if c, ok := colors[name]; ok {
		return c
	}
	return theme.DefaultTheme().Color(name, theme.VariantLight)
}

func (loginTheme) Size(name fyne.ThemeSizeName) float32 {
	if s, ok := sizes[name]; ok {
		return s
	}
	return theme.DefaultTheme().Size(name)
}
