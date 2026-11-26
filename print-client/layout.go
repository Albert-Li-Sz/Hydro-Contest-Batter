package main

import (
	"fmt"
	"strings"
)

// A print job as the Hydro print server sends it (lib/print-render.ts).
type Job struct {
	ID       string        `json:"id"`
	Title    string        `json:"title"`
	Contest  string        `json:"contest"`
	Header   Header        `json:"header"`
	Lines    [][][2]string `json:"lines"`
	Message  string        `json:"message"`
	FontSize float64       `json:"fontSize"`
	Numbers  bool          `json:"lineNumbers"`
	Printer  string        `json:"printer"`
	// "receipt": a balloon ticket for the receipt printer in Printer (receipt.go).
	Kind    string   `json:"kind"`
	Receipt *Receipt `json:"receipt"`
}

type Header struct {
	Team string      `json:"team"`
	Seat string      `json:"seat"`
	Rows [][2]string `json:"rows"`
}

// Font families the backends map to real fonts: monospace code, proportional header text.
const (
	FamilyMono = iota
	FamilySans
)

// Run styles from the server: "" plain, k bold, c italic grey, s dark grey, n plain, p bold.
type Style struct {
	Family int
	Size   float64 // points
	Bold   bool
	Italic bool
	Gray   float64 // 0 black … 1 white
}

func styleFor(code string, size float64) Style {
	s := Style{Family: FamilyMono, Size: size}
	switch code {
	case "k", "p":
		s.Bold = true
	case "c":
		s.Italic = true
		s.Gray = 0.35
	case "s":
		s.Gray = 0.2
	}
	return s
}

// Text drawn at (X, Y): Y is the baseline, both in points from the page's top-left corner.
// Wide marks text set in the CJK font (anything outside Latin-1).
type TextOp struct {
	X, Y  float64
	Style Style
	Text  string
	Wide  bool
}

type LineOp struct {
	X1, Y1, X2, Y2, Width float64
	Gray                  float64
}

type RectOp struct {
	X, Y, W, H, Width float64
}

type Page struct {
	Texts []TextOp
	Lines []LineOp
	Rects []RectOp
}

// Characters the Latin fonts (Courier, Helvetica in WinAnsi) cover; everything else uses the CJK font.
func narrow(r rune) bool { return r < 0x80 || (r >= 0xA0 && r <= 0xFF) }

// Widths by character class, the same for every backend so the layout is identical everywhere:
// Courier is exactly 0.6 em; CJK and other symbols are set full width.
func charWidth(r rune, s Style) float64 {
	if !narrow(r) {
		return s.Size
	}
	if s.Family == FamilyMono {
		return s.Size * 0.6
	}
	if r >= 32 && r < 127 {
		return s.Size * float64(helvetica[r-32]) / 1000
	}
	return s.Size * 0.556
}

// Helvetica advance widths (Adobe AFM) for printable ASCII; Arial on Windows shares them.
var helvetica = [95]int{
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
	556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
	1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
	333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
	556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
}

func textWidth(text string, s Style) float64 {
	w := 0.0
	for _, r := range text {
		w += charWidth(r, s)
	}
	return w
}

// Splits text into runs of Latin-1 and of other characters, each positioned from x.
func segments(page *Page, x, y float64, s Style, text string) float64 {
	var buf []rune
	wide := false
	start := x
	flush := func() {
		if len(buf) > 0 {
			page.Texts = append(page.Texts, TextOp{X: start, Y: y, Style: s, Text: string(buf), Wide: wide})
			buf = buf[:0]
		}
	}
	for _, r := range text {
		isWide := !narrow(r)
		if len(buf) > 0 && isWide != wide {
			flush()
		}
		if len(buf) == 0 {
			start = x
			wide = isWide
		}
		buf = append(buf, r)
		x += charWidth(r, s)
	}
	flush()
	return x
}

type Paper struct {
	Width, Height float64 // points
	Margin        float64
}

var A4 = Paper{Width: 595.28, Height: 841.89, Margin: 34}
var Letter = Paper{Width: 612, Height: 792, Margin: 34}

// One code line broken to fit: the runs of each visual line, and whether it starts the source line.
type visualLine struct {
	number int // 0 for a continuation
	runs   [][2]string
}

func wrapLine(runs [][2]string, number int, size, width float64) []visualLine {
	var out []visualLine
	current := visualLine{number: number}
	used := 0.0
	for _, run := range runs {
		s := styleFor(run[0], size)
		var piece []rune
		for _, r := range run[1] {
			w := charWidth(r, s)
			if used+w > width && (used > 0 || len(piece) > 0) {
				if len(piece) > 0 {
					current.runs = append(current.runs, [2]string{run[0], string(piece)})
					piece = piece[:0]
				}
				out = append(out, current)
				current = visualLine{}
				used = 0
			}
			piece = append(piece, r)
			used += w
		}
		if len(piece) > 0 {
			current.runs = append(current.runs, [2]string{run[0], string(piece)})
		}
	}
	return append(out, current)
}

func truncateToWidth(text string, s Style, maxWidth float64) string {
	if maxWidth <= 0 || textWidth(text, s) <= maxWidth {
		return text
	}
	r := []rune(text)
	for len(r) > 1 && textWidth(string(r)+"…", s) > maxWidth {
		r = r[:len(r)-1]
	}
	return string(r) + "…"
}

// Layout lays a job out on pages: the header box on every page, the code below it with line
// numbers and wrapped long lines, and the page number at the bottom.
func Layout(job Job, paper Paper) []Page {
	size := job.FontSize
	if size < 6 || size > 20 {
		size = 10
	}
	left, right := paper.Margin, paper.Width-paper.Margin
	top, bottom := paper.Margin, paper.Height-paper.Margin-14
	width := right - left

	// Header lines are the same on every page.
	contestStyle := Style{Family: FamilySans, Size: 8, Gray: 0.25}
	teamStyle := Style{Family: FamilySans, Size: 15, Bold: true}
	seatStyle := Style{Family: FamilySans, Size: 15, Bold: true}
	rowStyle := Style{Family: FamilySans, Size: 9}
	labelStyle := Style{Family: FamilySans, Size: 9, Bold: true, Gray: 0.2}
	seatText := ""
	if job.Header.Seat != "" {
		seatText = "座位 " + job.Header.Seat
	}
	seatWidth := 0.0
	if seatText != "" {
		seatWidth = textWidth(seatText, seatStyle) + 16
	}
	pad := 6.0
	inner := width - 2*pad
	// Rows wrap: items placed left to right, a new line when the next does not fit.
	type item struct{ label, value string }
	var rowLines [][]item
	var line []item
	used := 0.0
	for _, row := range job.Header.Rows {
		w := textWidth(row[0]+" ", labelStyle) + textWidth(row[1], rowStyle) + 14
		if len(line) > 0 && used+w > inner {
			rowLines = append(rowLines, line)
			line, used = nil, 0
		}
		line = append(line, item{row[0], row[1]})
		used += w
	}
	if len(line) > 0 {
		rowLines = append(rowLines, line)
	}
	maxHeaderText := inner
	if seatWidth > 0 {
		maxHeaderText = inner - seatWidth - 8
	}
	contestText := truncateToWidth(job.Contest, contestStyle, maxHeaderText)
	teamText := truncateToWidth(job.Header.Team, teamStyle, maxHeaderText)
	headerHeight := pad + 10 + 19 + float64(len(rowLines))*13 + pad
	if teamText == "" {
		headerHeight -= 19
	}

	numberWidth := 0.0
	if job.Numbers {
		digits := len(fmt.Sprint(len(job.Lines)))
		if digits < 2 {
			digits = 2
		}
		numberWidth = float64(digits)*size*0.6*0.85 + 8
	}
	codeLeft := left + numberWidth
	if job.Numbers {
		codeLeft += 6
	}
	lineHeight := size * 1.35
	var visual []visualLine
	if job.Lines == nil {
		visual = []visualLine{{number: 0, runs: [][2]string{{"c", job.Message}}}}
	} else {
		for index, runs := range job.Lines {
			visual = append(visual, wrapLine(runs, index+1, size, right-codeLeft)...)
		}
		if len(visual) == 0 {
			visual = []visualLine{{number: 1}}
		}
	}
	codeTop := top + headerHeight + 8
	perPage := int((bottom - codeTop) / lineHeight)
	if perPage < 1 {
		perPage = 1
	}
	total := (len(visual) + perPage - 1) / perPage
	pages := make([]Page, 0, total)
	for p := 0; p < total; p++ {
		var page Page
		// Header box.
		page.Rects = append(page.Rects, RectOp{X: left, Y: top, W: width, H: headerHeight, Width: 1.4})
		y := top + pad + 8
		segments(&page, left+pad, y, contestStyle, contestText)
		if seatText != "" {
			bx := right - pad - seatWidth
			page.Rects = append(page.Rects, RectOp{X: bx, Y: top + pad + 1, W: seatWidth, H: 24, Width: 1.4})
			segments(&page, bx+8, top+pad+19, seatStyle, seatText)
		}
		if teamText != "" {
			y += 19
			segments(&page, left+pad, y, teamStyle, teamText)
		}
		for _, row := range rowLines {
			y += 13
			x := left + pad
			for _, it := range row {
				x = segments(&page, x, y, labelStyle, it.label+" ")
				x = segments(&page, x, y, rowStyle, it.value) + 14
			}
		}
		// Code.
		end := (p + 1) * perPage
		if end > len(visual) {
			end = len(visual)
		}
		cy := codeTop
		for _, vl := range visual[p*perPage : end] {
			cy += lineHeight
			baseline := cy - lineHeight*0.25
			if job.Numbers && vl.number > 0 {
				ns := Style{Family: FamilyMono, Size: size * 0.85, Gray: 0.4}
				num := fmt.Sprint(vl.number)
				segments(&page, left+numberWidth-4-textWidth(num, ns), baseline, ns, num)
			}
			x := codeLeft
			for _, run := range vl.runs {
				x = segments(&page, x, baseline, styleFor(run[0], size), run[1])
			}
		}
		if job.Numbers {
			page.Lines = append(page.Lines, LineOp{X1: left + numberWidth, Y1: codeTop + 2, X2: left + numberWidth, Y2: cy + 2, Width: 0.6, Gray: 0.5})
		}
		// Footer: who it is for and the page.
		footer := Style{Family: FamilySans, Size: 8, Gray: 0.3}
		pageText := fmt.Sprintf("第 %d / %d 页", p+1, total)
		pageTextWidth := textWidth(pageText, footer)
		segments(&page, right-pageTextWidth, paper.Height-paper.Margin+2, footer, pageText)
		who := truncateToWidth(strings.TrimSpace(strings.Join([]string{job.Header.Team, seatText}, "  ")), footer, width-pageTextWidth-12)
		segments(&page, left, paper.Height-paper.Margin+2, footer, who)
		pages = append(pages, page)
	}
	return pages
}
