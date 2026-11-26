package main

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func sampleReceipt(mode string) Receipt {
	raw := []byte{0x1b, 0x40, 0x1c, 0x26, 'A', 0x0a, 0x1d, 0x56, 66, 0}
	return Receipt{Width: 80, Mode: mode, Cut: true, Raw: base64.StdEncoding.EncodeToString(raw), Lines: []ReceiptLine{
		{Text: "2026 校赛", Size: "s", Align: "center"},
		{Rule: true},
		{Text: "座位 A-12", Size: "xl", Bold: true, Align: "center"},
		{Text: "C 题 · 浅蓝", Size: "xl", Bold: true, Align: "center"},
		{Text: "★ 本题一血 ★", Size: "l", Bold: true, Align: "center", Invert: true},
		{Text: strings.Repeat("一支名字很长的参赛队伍", 4), Size: "l", Bold: true},
	}}
}

func TestBalancerLeavesReceiptPrintersOut(t *testing.T) {
	printers := []SysPrinter{{Name: "Laser", Status: "idle"}, {Name: "Ticket", Status: "idle"}}
	prefs := map[string]Preference{"Laser": {Enabled: true, Weight: 1}, "Ticket": {Enabled: true, Weight: 10, Kind: "receipt"}}
	var b Balancer
	for i := 0; i < 20; i++ {
		if name, ok := b.pick(printers, prefs); !ok || name != "Laser" {
			t.Fatalf("pick %d: got %q, want Laser (receipt printers take no printouts)", i, name)
		}
	}
	if n := b.available(printers, prefs); n != 1 {
		t.Errorf("available: got %d, want 1", n)
	}
	if n := usable(printers, prefs); n != 1 {
		t.Errorf("usable: got %d, want 1", n)
	}
	if n := receiptPrinters(printers, prefs); n != 1 {
		t.Errorf("receiptPrinters: got %d, want 1", n)
	}
	prefs["Ticket"] = Preference{Enabled: false, Kind: "receipt"}
	if n := receiptPrinters(printers, prefs); n != 0 {
		t.Errorf("a disabled receipt printer counted: %d", n)
	}
}

func TestReceiptLayoutStaysOnThePaper(t *testing.T) {
	for _, width := range []int{58, 80} {
		r := sampleReceipt("driver")
		r.Width = width
		paper := receiptPaper(r)
		page, height := ReceiptLayout(r, paper.Width, paper.Margin)
		if len(page.Texts) == 0 || len(page.Lines) != 1 || len(page.Rects) != 1 {
			t.Fatalf("%d mm: texts %d, rules %d, boxes %d", width, len(page.Texts), len(page.Lines), len(page.Rects))
		}
		for _, text := range page.Texts {
			if text.X < paper.Margin-0.01 || text.X+textWidth(text.Text, text.Style) > paper.Width-paper.Margin+0.01 {
				t.Errorf("%d mm: %q runs off the paper (x %.1f)", width, text.Text, text.X)
			}
			if text.Y > height {
				t.Errorf("%d mm: %q below the page end", width, text.Text)
			}
		}
	}
	short := Receipt{Width: 80, Lines: []ReceiptLine{{Text: "A", Size: "m"}}}
	_, small := ReceiptLayout(short, 200, 10)
	_, tall := ReceiptLayout(sampleReceipt("driver"), 200, 10)
	if tall <= small {
		t.Errorf("height does not follow the content: %.1f vs %.1f", tall, small)
	}
}

func TestReceiptGoesRawToTheQueue(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("CUPS is used on macOS and Linux")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "lp.log")
	script := "#!/bin/sh\necho \"$@\" > " + log + "\nfor last; do :; done\n/bin/cp \"$last\" " + filepath.Join(dir, "sent") + "\n"
	if err := os.WriteFile(filepath.Join(dir, "lp"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	r := sampleReceipt("escpos")
	if err := printReceipt("Ticket", Job{Title: "气球 #1", Kind: "receipt", Receipt: &r}); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(log)
	if !strings.Contains(string(args), "-d Ticket") || !strings.Contains(string(args), "-o raw") {
		t.Errorf("lp arguments: %s", args)
	}
	sent, _ := os.ReadFile(filepath.Join(dir, "sent"))
	raw, _ := base64.StdEncoding.DecodeString(r.Raw)
	if !bytes.Equal(sent, raw) {
		t.Errorf("the printer got %x, want %x", sent, raw)
	}
	// Through the driver: a PDF on paper as long as the ticket.
	r = sampleReceipt("driver")
	if err := printReceipt("Ticket", Job{Title: "气球 #2", Kind: "receipt", Receipt: &r}); err != nil {
		t.Fatal(err)
	}
	args, _ = os.ReadFile(log)
	if !strings.Contains(string(args), "media=Custom.80x") || strings.Contains(string(args), "-o raw") {
		t.Errorf("driver lp arguments: %s", args)
	}
	sent, _ = os.ReadFile(filepath.Join(dir, "sent"))
	if !bytes.HasPrefix(sent, []byte("%PDF-")) {
		t.Errorf("the driver got no PDF")
	}
}

func TestReceiptToFolder(t *testing.T) {
	dir := t.TempDir()
	folder, folderCount = dir, 1
	defer func() { folder, folderCount = "", 1 }()
	r := sampleReceipt("escpos")
	if err := printReceipt("保存到文件夹 1", Job{Title: "气球 #3", Kind: "receipt", Receipt: &r}); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*"))
	var pdf, raw bool
	for _, file := range files {
		pdf = pdf || strings.HasSuffix(file, ".pdf")
		raw = raw || strings.HasSuffix(file, ".escpos")
	}
	if !pdf || !raw {
		t.Errorf("folder printer wrote %v", files)
	}
	// Two jobs in the same second with distinct IDs must produce separate files.
	if err := printReceipt("保存到文件夹 1", Job{ID: "job-a", Title: "气球 #3", Kind: "receipt", Receipt: &r}); err != nil {
		t.Fatal(err)
	}
	if err := printReceipt("保存到文件夹 1", Job{ID: "job-b", Title: "气球 #3", Kind: "receipt", Receipt: &r}); err != nil {
		t.Fatal(err)
	}
	pdfs, _ := filepath.Glob(filepath.Join(dir, "*.pdf"))
	if len(pdfs) != 3 {
		t.Errorf("want 3 distinct PDF files, got %v", pdfs)
	}
}
