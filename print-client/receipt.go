package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Balloon tickets (气球配送) for receipt printers. The server sends the lines and, for printers set
// to ESC/POS, the printer's own command bytes (lib/escpos.ts), which go to the printer unchanged.
// Printers set to "system driver" get the lines drawn at the paper's width instead.
type ReceiptLine struct {
	Text   string `json:"text"`
	Size   string `json:"size"` // s, m, l, xl
	Bold   bool   `json:"bold"`
	Align  string `json:"align"` // left, center
	Invert bool   `json:"invert"`
	Rule   bool   `json:"rule"`
}

type Receipt struct {
	Width int           `json:"width"` // mm: 58 or 80
	Mode  string        `json:"mode"`  // escpos or driver
	Cut   bool          `json:"cut"`
	Lines []ReceiptLine `json:"lines"`
	Raw   string        `json:"raw"` // base64 ESC/POS
}

const pointsPerMM = 72 / 25.4

var receiptSizes = map[string]float64{"s": 8, "m": 10, "l": 15, "xl": 24}

// The paper a receipt is drawn on: its width, the unprintable side margins of thermal heads
// (72 mm of 80, 48 mm of 58), and a height that fits the content.
func receiptPaper(r Receipt) Paper {
	width := 80.0
	if r.Width == 58 {
		width = 58
	}
	margin := 4.0
	if width == 58 {
		margin = 5
	}
	return Paper{Width: width * pointsPerMM, Margin: margin * pointsPerMM}
}

// Breaks text into pieces no wider than width at this style.
func wrapText(text string, s Style, width float64) []string {
	var lines []string
	var current []rune
	used := 0.0
	for _, r := range text {
		w := charWidth(r, s)
		if used+w > width && len(current) > 0 {
			lines = append(lines, string(current))
			current, used = nil, 0
		}
		current = append(current, r)
		used += w
	}
	return append(lines, string(current))
}

// ReceiptLayout draws the lines on one page `width` points wide (the margins from receiptPaper)
// and returns it with the height it needs.
func ReceiptLayout(r Receipt, width, margin float64) (Page, float64) {
	var page Page
	left, right := margin, width-margin
	inner := right - left
	y := margin + 2
	for _, line := range r.Lines {
		size, ok := receiptSizes[line.Size]
		if !ok {
			size = 10
		}
		if line.Rule {
			y += 4
			page.Lines = append(page.Lines, LineOp{X1: left, Y1: y, X2: right, Y2: y, Width: 0.8})
			y += 4
			continue
		}
		s := Style{Family: FamilySans, Size: size, Bold: line.Bold}
		height := size * 1.3
		for _, part := range wrapText(line.Text, s, inner) {
			y += height
			baseline := y - height*0.22
			x := left
			if line.Align == "center" {
				x = left + (inner-textWidth(part, s))/2
			}
			if line.Invert {
				// Boxed here; ESC/POS prints it white on black.
				w := textWidth(part, s)
				page.Rects = append(page.Rects, RectOp{X: x - 4, Y: y - height + 1, W: w + 8, H: height, Width: 1.4})
			}
			segments(&page, x, baseline, s, part)
		}
	}
	return page, y + margin + 6*pointsPerMM
}

// ReceiptPDF is the ticket as a PDF sized to its content (folder printers, and drivers on macOS and Linux).
func ReceiptPDF(r Receipt, title string) ([]byte, Paper) {
	paper := receiptPaper(r)
	page, height := ReceiptLayout(r, paper.Width, paper.Margin)
	paper.Height = height
	return WritePDF([]Page{page}, paper, title), paper
}

var safeName = regexp.MustCompile(`[^\w\-.\p{Han}]+`)

func printReceipt(printer string, job Job) error {
	if job.Receipt == nil {
		return errors.New("小票内容为空")
	}
	r := *job.Receipt
	if folder != "" && strings.HasPrefix(printer, "保存到文件夹 ") {
		name := safeName.ReplaceAllString(fmt.Sprintf("%s-%s-%s", time.Now().Format("150405"), strings.TrimPrefix(printer, "保存到文件夹 "), job.Title), "_")
		data, _ := ReceiptPDF(r, job.Title)
		if err := os.WriteFile(filepath.Join(folder, name+".pdf"), data, 0o644); err != nil {
			return err
		}
		if r.Raw != "" {
			raw, _ := base64.StdEncoding.DecodeString(r.Raw)
			return os.WriteFile(filepath.Join(folder, name+".escpos"), raw, 0o644)
		}
		return nil
	}
	if r.Mode == "escpos" && r.Raw != "" {
		raw, err := base64.StdEncoding.DecodeString(r.Raw)
		if err != nil {
			return errors.New("小票指令无效")
		}
		return printRaw(printer, job.Title, raw)
	}
	return printReceiptDriver(printer, job.Title, r)
}
