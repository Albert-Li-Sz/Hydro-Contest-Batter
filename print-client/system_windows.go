//go:build windows

package main

import (
	"fmt"
	"math"
	"os"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

// Windows printing with the system's own winspool and GDI: no driver, viewer or helper program.
var (
	winspool            = syscall.NewLazyDLL("winspool.drv")
	procEnumPrinters    = winspool.NewProc("EnumPrintersW")
	procGetDefault      = winspool.NewProc("GetDefaultPrinterW")
	procOpenPrinter     = winspool.NewProc("OpenPrinterW")
	procClosePrinter    = winspool.NewProc("ClosePrinter")
	procStartDocPrinter = winspool.NewProc("StartDocPrinterW")
	procEndDocPrinter   = winspool.NewProc("EndDocPrinter")
	procStartPagePrint  = winspool.NewProc("StartPagePrinter")
	procEndPagePrinter  = winspool.NewProc("EndPagePrinter")
	procWritePrinter    = winspool.NewProc("WritePrinter")
	gdi32               = syscall.NewLazyDLL("gdi32.dll")
	procCreateDC        = gdi32.NewProc("CreateDCW")
	procDeleteDC        = gdi32.NewProc("DeleteDC")
	procStartDoc        = gdi32.NewProc("StartDocW")
	procEndDoc          = gdi32.NewProc("EndDoc")
	procAbortDoc        = gdi32.NewProc("AbortDoc")
	procStartPage       = gdi32.NewProc("StartPage")
	procEndPage         = gdi32.NewProc("EndPage")
	procCreateFont      = gdi32.NewProc("CreateFontW")
	procSelectObject    = gdi32.NewProc("SelectObject")
	procDeleteObject    = gdi32.NewProc("DeleteObject")
	procSetTextColor    = gdi32.NewProc("SetTextColor")
	procSetBkMode       = gdi32.NewProc("SetBkMode")
	procSetTextAlign    = gdi32.NewProc("SetTextAlign")
	procExtTextOut      = gdi32.NewProc("ExtTextOutW")
	procGetDeviceCaps   = gdi32.NewProc("GetDeviceCaps")
	procCreatePen       = gdi32.NewProc("CreatePen")
	procMoveTo          = gdi32.NewProc("MoveToEx")
	procLineTo          = gdi32.NewProc("LineTo")
	procRectangle       = gdi32.NewProc("Rectangle")
	procGetStockObject  = gdi32.NewProc("GetStockObject")
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	procConsoleProcList = kernel32.NewProc("GetConsoleProcessList")
	ntdll               = syscall.NewLazyDLL("ntdll.dll")
	procRtlGetVersion   = ntdll.NewProc("RtlGetVersion")
)

type printerInfo2 struct {
	ServerName, PrinterName, ShareName, PortName, DriverName, Comment, Location *uint16
	DevMode                                                                     uintptr
	SepFile, PrintProcessor, Datatype, Parameters                               *uint16
	SecurityDescriptor                                                          uintptr
	Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, Jobs   uint32
	AveragePPM                                                                  uint32
}

type docInfo struct {
	Size     int32
	DocName  *uint16
	Output   *uint16
	Datatype *uint16
	Type     uint32
}

const (
	enumLocal       = 0x2
	enumConnections = 0x4
	statusPaused    = 0x1
	statusError     = 0x2
	statusPaperJam  = 0x8
	statusPaperOut  = 0x10
	statusOffline   = 0x80
	statusPrinting  = 0x400
	statusNoToner   = 0x40000
	statusDoorOpen  = 0x400000
	statusNotAvail  = 0x1000
	attrWorkOffline = 0x400
)

func utf16String(p *uint16) string {
	if p == nil {
		return ""
	}
	var units []uint16
	for ptr := unsafe.Pointer(p); ; ptr = unsafe.Add(ptr, 2) {
		unit := *(*uint16)(ptr)
		if unit == 0 {
			break
		}
		units = append(units, unit)
	}
	return string(utf16.Decode(units))
}

func utf16Ptr(text string) *uint16 {
	p, err := syscall.UTF16PtrFromString(strings.ReplaceAll(text, "\x00", ""))
	if err != nil {
		p, _ = syscall.UTF16PtrFromString("")
	}
	return p
}

func listPrinters() ([]SysPrinter, error) {
	var needed, count uint32
	var buffer []byte
	for attempt := 0; attempt < 3; attempt++ {
		procEnumPrinters.Call(enumLocal|enumConnections, 0, 2, 0, 0, uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&count)))
		if needed == 0 {
			return nil, nil
		}
		buffer = make([]byte, needed)
		r, _, err := procEnumPrinters.Call(enumLocal|enumConnections, 0, 2, uintptr(unsafe.Pointer(&buffer[0])), uintptr(needed),
			uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&count)))
		if r != 0 {
			break
		}
		if err == syscall.ERROR_INSUFFICIENT_BUFFER && attempt < 2 {
			continue
		}
		return nil, fmt.Errorf("无法读取打印机列表：%v", err)
	}
	defaultName := ""
	var size uint32 = 512
	name := make([]uint16, size)
	if r, _, _ := procGetDefault.Call(uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&size))); r != 0 {
		defaultName = syscall.UTF16ToString(name)
	}
	infos := unsafe.Slice((*printerInfo2)(unsafe.Pointer(&buffer[0])), count)
	printers := make([]SysPrinter, 0, count)
	for _, info := range infos {
		p := SysPrinter{Name: utf16String(info.PrinterName), Queue: int(info.Jobs), Status: "idle"}
		p.IsDefault = p.Name == defaultName
		port := utf16String(info.PortName)
		p.Virtual = virtualPrinter(p.Name) || virtualPort(port)
		switch {
		case info.Attributes&attrWorkOffline != 0 || info.Status&(statusOffline|statusNotAvail) != 0:
			p.Status, p.Message = "offline", "打印机脱机"
		case info.Status&statusPaperOut != 0:
			p.Status, p.Message = "error", "缺纸"
		case info.Status&statusPaperJam != 0:
			p.Status, p.Message = "error", "卡纸"
		case info.Status&statusNoToner != 0:
			p.Status, p.Message = "error", "缺墨粉"
		case info.Status&statusDoorOpen != 0:
			p.Status, p.Message = "error", "机盖打开"
		case info.Status&statusError != 0:
			p.Status, p.Message = "error", "打印机故障"
		case info.Status&statusPaused != 0:
			p.Status = "paused"
		case info.Status&statusPrinting != 0:
			p.Status = "printing"
		}
		printers = append(printers, p)
	}
	return printers, nil
}

func virtualPort(port string) bool {
	switch port {
	case "PORTPROMPT:", "nul:", "XPSPort:", "SHRFAX:", "FILE:":
		return true
	}
	return false
}

const (
	capPixelsX    = 88
	capPixelsY    = 90
	capPhysW      = 110
	capPhysH      = 111
	capOffsetX    = 112
	capOffsetY    = 113
	taBaseline    = 24
	bkTransparent = 1
	nullBrush     = 5
	systemFont    = 13
)

func caps(hdc uintptr, index int) float64 {
	r, _, _ := procGetDeviceCaps.Call(hdc, uintptr(index))
	return float64(int32(r))
}

// DOC_INFO_1 for a RAW spool job.
type docInfo1 struct {
	DocName, OutputFile, Datatype *uint16
}

// printRaw spools bytes the printer understands itself (ESC/POS) as a RAW job: the driver passes them on unchanged.
func printRaw(printer, title string, data []byte) error {
	if len(data) == 0 {
		return nil
	}
	var handle uintptr
	if r, _, err := procOpenPrinter.Call(uintptr(unsafe.Pointer(utf16Ptr(printer))), uintptr(unsafe.Pointer(&handle)), 0); r == 0 {
		return fmt.Errorf("无法打开小票机 %s：%v", printer, err)
	}
	defer procClosePrinter.Call(handle)
	info := docInfo1{DocName: utf16Ptr(title), Datatype: utf16Ptr("RAW")}
	if r, _, err := procStartDocPrinter.Call(handle, 1, uintptr(unsafe.Pointer(&info))); r == 0 {
		return fmt.Errorf("小票机 %s 拒绝了打印任务：%v", printer, err)
	}
	defer procEndDocPrinter.Call(handle)
	if r, _, err := procStartPagePrint.Call(handle); r == 0 {
		return fmt.Errorf("小票机 %s 无法开始打印：%v", printer, err)
	}
	var written uint32
	r, _, err := procWritePrinter.Call(handle, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), uintptr(unsafe.Pointer(&written)))
	procEndPagePrinter.Call(handle)
	if r == 0 || int(written) != len(data) {
		return fmt.Errorf("向小票机 %s 发送数据失败：%v", printer, err)
	}
	return nil
}

// printReceiptDriver draws a ticket through the printer's driver at the width of its paper.
func printReceiptDriver(printer, title string, r Receipt) error {
	return drawPages(printer, title, func(paper Paper) []Page {
		margin := receiptPaper(r).Margin
		if paper.Margin > margin {
			margin = paper.Margin
		}
		page, _ := ReceiptLayout(r, paper.Width, margin)
		return []Page{page}
	})
}

// printOn draws the job straight to the printer: the page size comes from the printer itself.
func printOn(printer string, job Job, _ Paper) error {
	return drawPages(printer, job.Title, func(paper Paper) []Page { return Layout(job, paper) })
}

// drawPages draws the pages `layout` makes for the printer's own page size, with GDI.
func drawPages(printer, title string, layout func(Paper) []Page) error {
	hdc, _, err := procCreateDC.Call(uintptr(unsafe.Pointer(utf16Ptr("WINSPOOL"))), uintptr(unsafe.Pointer(utf16Ptr(printer))), 0, 0)
	if hdc == 0 {
		return fmt.Errorf("无法打开打印机 %s：%v", printer, err)
	}
	defer procDeleteDC.Call(hdc)
	dpiX, dpiY := caps(hdc, capPixelsX), caps(hdc, capPixelsY)
	if dpiX <= 0 || dpiY <= 0 {
		return fmt.Errorf("打印机 %s 没有返回分辨率", printer)
	}
	offX, offY := caps(hdc, capOffsetX), caps(hdc, capOffsetY)
	paper := Paper{Width: caps(hdc, capPhysW) * 72 / dpiX, Height: caps(hdc, capPhysH) * 72 / dpiY, Margin: 34}
	if paper.Width <= 0 || paper.Height <= 0 {
		paper = A4
	}
	// Keep the layout inside the printable area.
	unprintable := math.Max(offX*72/dpiX, offY*72/dpiY) + 6
	if unprintable > paper.Margin {
		paper.Margin = unprintable
	}
	pages := layout(paper)

	info := docInfo{DocName: utf16Ptr(title)}
	info.Size = int32(unsafe.Sizeof(info))
	if r, _, err := procStartDoc.Call(hdc, uintptr(unsafe.Pointer(&info))); int32(r) <= 0 {
		return fmt.Errorf("打印机 %s 拒绝了打印任务：%v", printer, err)
	}
	px := func(x float64) int32 { return int32(math.Round(x*dpiX/72 - offX)) }
	py := func(y float64) int32 { return int32(math.Round(y*dpiY/72 - offY)) }
	fonts := map[string]uintptr{}
	// Runs before the DC is deleted: a font still selected into the DC cannot be deleted, so put
	// a stock font back first, or every job would leak its fonts.
	defer func() {
		stock, _, _ := procGetStockObject.Call(systemFont)
		procSelectObject.Call(hdc, stock)
		for _, font := range fonts {
			procDeleteObject.Call(font)
		}
	}()
	font := func(s Style, wide bool) uintptr {
		face := "Courier New"
		if wide {
			face = "Microsoft YaHei"
		} else if s.Family == FamilySans {
			face = "Arial"
		}
		key := fmt.Sprintf("%s/%.2f/%v/%v", face, s.Size, s.Bold, s.Italic)
		if f, ok := fonts[key]; ok {
			return f
		}
		weight, italic := 400, 0
		if s.Bold {
			weight = 700
		}
		if s.Italic {
			italic = 1
		}
		height := -int32(math.Round(s.Size * dpiY / 72))
		f, _, _ := procCreateFont.Call(uintptr(height), 0, 0, 0, uintptr(weight), uintptr(italic), 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(utf16Ptr(face))))
		fonts[key] = f
		return f
	}
	failed := func(step string) error {
		procAbortDoc.Call(hdc)
		return fmt.Errorf("打印机 %s 在%s时出错", printer, step)
	}
	for _, page := range pages {
		if r, _, _ := procStartPage.Call(hdc); int32(r) <= 0 {
			return failed("开始新页")
		}
		procSetBkMode.Call(hdc, bkTransparent)
		procSetTextAlign.Call(hdc, taBaseline)
		brush, _, _ := procGetStockObject.Call(nullBrush)
		procSelectObject.Call(hdc, brush)
		for _, r := range page.Rects {
			pen, _, _ := procCreatePen.Call(0, uintptr(math.Max(1, math.Round(r.Width*dpiX/72))), 0)
			old, _, _ := procSelectObject.Call(hdc, pen)
			procRectangle.Call(hdc, uintptr(px(r.X)), uintptr(py(r.Y)), uintptr(px(r.X+r.W)), uintptr(py(r.Y+r.H)))
			procSelectObject.Call(hdc, old)
			procDeleteObject.Call(pen)
		}
		for _, l := range page.Lines {
			g := uintptr(math.Round(l.Gray * 255))
			pen, _, _ := procCreatePen.Call(0, uintptr(math.Max(1, math.Round(l.Width*dpiX/72))), g|g<<8|g<<16)
			old, _, _ := procSelectObject.Call(hdc, pen)
			procMoveTo.Call(hdc, uintptr(px(l.X1)), uintptr(py(l.Y1)), 0)
			procLineTo.Call(hdc, uintptr(px(l.X2)), uintptr(py(l.Y2)))
			procSelectObject.Call(hdc, old)
			procDeleteObject.Call(pen)
		}
		for _, t := range page.Texts {
			procSelectObject.Call(hdc, font(t.Style, t.Wide))
			g := uintptr(math.Round(t.Style.Gray * 255))
			procSetTextColor.Call(hdc, g|g<<8|g<<16)
			units := utf16.Encode([]rune(t.Text))
			if len(units) == 0 {
				continue
			}
			// Advances from the shared layout, so every printer and system lines code up alike;
			// proportional header text keeps its own widths.
			var dx []int32
			if t.Wide || t.Style.Family == FamilyMono {
				x := t.X
				prev := px(x)
				for _, r := range t.Text {
					x += charWidth(r, t.Style)
					next := px(x)
					if r > 0xFFFF {
						dx = append(dx, next-prev, 0)
					} else {
						dx = append(dx, next-prev)
					}
					prev = next
				}
			}
			var dxPtr uintptr
			if len(dx) == len(units) {
				dxPtr = uintptr(unsafe.Pointer(&dx[0]))
			}
			procExtTextOut.Call(hdc, uintptr(px(t.X)), uintptr(py(t.Y)), 0, 0, uintptr(unsafe.Pointer(&units[0])), uintptr(len(units)), dxPtr)
		}
		if r, _, _ := procEndPage.Call(hdc); int32(r) <= 0 {
			return failed("结束一页")
		}
	}
	if r, _, _ := procEndDoc.Call(hdc); int32(r) <= 0 {
		return fmt.Errorf("打印机 %s 没有接受打印任务", printer)
	}
	return nil
}

func systemName() string {
	type osVersion struct {
		Size, Major, Minor, Build, Platform uint32
		CSD                                 [128]uint16
	}
	v := osVersion{}
	v.Size = uint32(unsafe.Sizeof(v))
	if r, _, _ := procRtlGetVersion.Call(uintptr(unsafe.Pointer(&v))); r == 0 {
		name := "Windows 10"
		if v.Major == 10 && v.Build >= 22000 {
			name = "Windows 11"
		} else if v.Major < 10 {
			name = fmt.Sprintf("Windows %d.%d", v.Major, v.Minor)
		}
		return fmt.Sprintf("%s（%d）", name, v.Build)
	}
	return "Windows"
}

// Started by double-clicking, the console closes with the program: keep it open to show why.
func waitBeforeExit() {
	list := make([]uint32, 4)
	r, _, _ := procConsoleProcList.Call(uintptr(unsafe.Pointer(&list[0])), 4)
	if r == 1 {
		fmt.Fprint(os.Stderr, "\n按回车键退出…")
		var b [1]byte
		os.Stdin.Read(b[:])
	}
}
