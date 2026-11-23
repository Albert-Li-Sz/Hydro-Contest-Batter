//go:build !windows

package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

// Request English output where CUPS honors the process locale.
func cups(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), "LANG=C", "LC_ALL=C")
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	if err != nil {
		message := strings.TrimSpace(errOut.String())
		if message == "" {
			message = err.Error()
		}
		return out.String(), fmt.Errorf("%s: %s", name, message)
	}
	return out.String(), nil
}

var printerLine = regexp.MustCompile(`^printer (\S+) (?:is |now )?(\S+)`)

func listPrinters() ([]SysPrinter, error) {
	out, err := cups("lpstat", "-p")
	if err != nil && strings.TrimSpace(out) == "" {
		if strings.Contains(err.Error(), "No destinations") || strings.Contains(err.Error(), "no destinations") {
			return nil, nil
		}
		return nil, fmt.Errorf("无法读取打印机列表（需要 CUPS 的 lpstat）：%v", err)
	}
	defaultName := ""
	if d, err := cups("lpstat", "-d"); err == nil {
		if _, name, ok := strings.Cut(strings.ReplaceAll(d, "：", ":"), ":"); ok {
			defaultName = strings.TrimSpace(name)
		}
	}
	var printers []SysPrinter
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		m := printerLine.FindStringSubmatch(line)
		if m == nil {
			// A reason line under the printer ("\tPaper out").
			if len(printers) > 0 && strings.HasPrefix(line, "\t") {
				printers[len(printers)-1].Message = strings.TrimSpace(line)
			}
			continue
		}
		p := SysPrinter{Name: m[1], Status: "idle"}
		switch {
		case strings.Contains(line, "disabled"):
			p.Status = "paused"
		case strings.Contains(line, "now printing"):
			p.Status = "printing"
		}
		printers = append(printers, p)
	}
	if len(printers) == 0 && strings.TrimSpace(out) != "" {
		// macOS CUPS can use the user's preferred language despite LC_ALL.
		printers, err = listCUPSDestinations()
		if err != nil {
			return nil, err
		}
	}
	for i := range printers {
		p := &printers[i]
		p.IsDefault = p.Name == defaultName
		p.Virtual = virtualPrinter(p.Name)
		if jobs, err := cups("lpstat", "-o", p.Name); err == nil {
			if trimmed := strings.TrimSpace(jobs); trimmed != "" {
				p.Queue = strings.Count(trimmed, "\n") + 1
			}
		}
	}
	return printers, nil
}

// lpoptions quotes option values that contain spaces. Match whole options so
// that a printer description cannot be mistaken for a state attribute.
var cupsOption = regexp.MustCompile(`[^=\s]+=(?:'[^']*'|\S+)`)

func listCUPSDestinations() ([]SysPrinter, error) {
	out, err := cups("lpstat", "-l", "-e")
	if err != nil {
		return nil, fmt.Errorf("无法读取 CUPS 打印队列：%w", err)
	}
	var printers []SysPrinter
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		// Only registered queues have a permanent or temporary CUPS destination.
		if len(fields) < 3 || (fields[1] != "permanent" && fields[1] != "temporary") {
			continue
		}
		p := SysPrinter{Name: fields[0], Status: "offline"}
		if options, err := cups("lpoptions", "-p", p.Name); err == nil {
			accepting := true
			for _, option := range cupsOption.FindAllString(options, -1) {
				switch option {
				case "printer-state=3":
					p.Status = "idle"
				case "printer-state=4":
					p.Status = "printing"
				case "printer-state=5":
					p.Status = "paused"
				case "printer-is-accepting-jobs=false":
					accepting = false
				}
			}
			if !accepting {
				p.Status = "paused"
			}
		}
		printers = append(printers, p)
	}
	return printers, nil
}

func printOn(printer string, job Job, paper Paper) error {
	pages := Layout(job, paper)
	file, err := os.CreateTemp("", "hydro-print-*.pdf")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(WritePDF(pages, paper, job.Title)); err != nil {
		file.Close()
		return err
	}
	file.Close()
	media := "A4"
	if paper == Letter {
		media = "Letter"
	}
	title := job.Title
	if title == "" {
		title = "Hydro"
	}
	_, err = cups("lp", "-d", printer, "-t", title, "-o", "media="+media, file.Name())
	return err
}

// printRaw sends bytes the printer understands itself (ESC/POS) past any driver filter.
func printRaw(printer, title string, data []byte) error {
	file, err := os.CreateTemp("", "hydro-ticket-*.bin")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	file.Close()
	if title == "" {
		title = "Hydro"
	}
	_, err = cups("lp", "-d", printer, "-t", title, "-o", "raw", file.Name())
	return err
}

// printReceiptDriver prints a ticket through the printer's CUPS driver, on paper as long as the ticket.
func printReceiptDriver(printer, title string, r Receipt) error {
	data, paper := ReceiptPDF(r, title)
	file, err := os.CreateTemp("", "hydro-ticket-*.pdf")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	file.Close()
	media := fmt.Sprintf("Custom.%.0fx%.0fmm", paper.Width/pointsPerMM, paper.Height/pointsPerMM+0.5)
	if title == "" {
		title = "Hydro"
	}
	_, err = cups("lp", "-d", printer, "-t", title, "-o", "media="+media, "-o", "print-scaling=none", file.Name())
	return err
}

func systemName() string {
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("sw_vers", "-productVersion").Output(); err == nil {
			return "macOS " + strings.TrimSpace(string(out))
		}
		return "macOS"
	}
	if data, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	return runtime.GOOS
}

// Nothing to keep open on these systems.
func waitBeforeExit() {}
