// Hydro print client: one file, no installation. It connects to Hydro with the connection code
// from 打印服务器管理, reports this PC's printers, takes the print requests assigned to it and
// prints them, balancing between the printers by their weights.
package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Set at build time (scripts/build-print-client.mjs) to the plugin version.
var version = "dev"

// A printer as the operating system reports it.
type SysPrinter struct {
	Name      string `json:"name"`
	Status    string `json:"status"` // idle, printing, paused, error, offline
	Queue     int    `json:"queue"`
	Message   string `json:"message"`
	IsDefault bool   `json:"isDefault"`
	Virtual   bool   `json:"virtual"`
}

var virtualName = regexp.MustCompile(`(?i)pdf|xps|onenote|fax|传真|send to|microsoft print`)

// PDF, XPS, fax and OneNote printers are files, not paper: off by default on the management page.
func virtualPrinter(name string) bool { return virtualName.MatchString(name) }

type Connection struct {
	URL   string `json:"url"`
	ID    string `json:"id"`
	Token string `json:"token"`
}

type Config struct {
	Connection
	Paper    string `json:"paper,omitempty"`
	Insecure bool   `json:"insecure,omitempty"`
}

var validServerID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func parseCode(code string) (Connection, error) {
	code = strings.TrimSpace(code)
	const prefix = "hydro-print:"
	if !strings.HasPrefix(code, prefix) {
		return Connection{}, errors.New("连接信息应以 hydro-print: 开头，请从“打印服务器管理”中完整复制")
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(code[len(prefix):], "="))
	if err != nil {
		return Connection{}, errors.New("连接信息不完整，请重新复制")
	}
	var c Connection
	if err := json.Unmarshal(data, &c); err != nil || c.URL == "" || c.ID == "" || c.Token == "" {
		return Connection{}, errors.New("连接信息无效，请重新复制")
	}
	c.URL = strings.TrimRight(c.URL, "/")
	u, err := url.Parse(c.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return Connection{}, errors.New("连接信息中的服务器地址无效，请重新复制")
	}
	if !validServerID.MatchString(c.ID) {
		return Connection{}, errors.New("连接信息中的服务器编号无效，请重新复制")
	}
	return c, nil
}

// The config lives next to the program, so the folder can be copied as is; elsewhere when that is read-only.
func configPath() string {
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		probe := filepath.Join(dir, ".hydro-print-write-test")
		if f, err := os.Create(probe); err == nil {
			f.Close()
			os.Remove(probe)
			return filepath.Join(dir, "hydro-print-client.json")
		}
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	os.MkdirAll(filepath.Join(dir, "hydro-print-client"), 0o700)
	return filepath.Join(dir, "hydro-print-client", "config.json")
}

func loadConfig(path string) (Config, bool) {
	var c Config
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &c) != nil || c.Token == "" {
		return c, false
	}
	return c, true
}

func saveConfig(path string, c Config) error {
	data, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(path, data, 0o600)
}

func logf(format string, args ...any) {
	fmt.Printf("%s  %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
}

// ---------------------------------------------------------------- Hydro

type Client struct {
	conn Connection
	http *http.Client
}

var errUnauthorized = errors.New("连接信息无效或已重新生成")

// The server answered and refused (4xx): retrying the same request cannot help.
type refusedError struct{ message string }

func (e refusedError) Error() string { return e.message }

func (c *Client) call(action string, body any, out any) error {
	data, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", fmt.Sprintf("%s/xcpcio-print/%s/%s", c.conn.URL, c.conn.ID, action), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.conn.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "hydro-print-client/"+version)
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("无法连接 %s：%v", c.conn.URL, err)
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return fmt.Errorf("读取 Hydro 响应失败：%v", err)
	}
	if res.StatusCode >= 300 && res.StatusCode < 400 {
		return fmt.Errorf("Hydro 返回意外重定向 %d，请检查服务器地址配置", res.StatusCode)
	}
	if res.StatusCode == 401 {
		return errUnauthorized
	}
	if res.StatusCode != 200 {
		var e struct {
			Error any `json:"error"`
		}
		json.Unmarshal(payload, &e)
		message := fmt.Sprintf("Hydro 返回 %d", res.StatusCode)
		if text, ok := e.Error.(string); ok {
			message = text
		} else if m, ok := e.Error.(map[string]any); ok && m["message"] != nil {
			message = fmt.Sprint(m["message"])
		}
		if res.StatusCode >= 400 && res.StatusCode < 500 {
			return refusedError{message}
		}
		return errors.New(message)
	}
	if out != nil {
		return json.Unmarshal(payload, out)
	}
	return nil
}

type Preference struct {
	Enabled bool   `json:"enabled"`
	Weight  int    `json:"weight"`
	Kind    string `json:"kind"` // "receipt": a 小票机, which prints only balloon tickets
}

// Whether the printer takes printouts (code): enabled and not a receipt printer.
func (p Preference) documents() bool { return p.Enabled && p.Kind != "receipt" }

type heartbeatReply struct {
	Name        string                `json:"name"`
	Enabled     bool                  `json:"enabled"`
	PollMs      int                   `json:"pollMs"`
	Preferences map[string]Preference `json:"preferences"`
}

// ---------------------------------------------------------------- Balancing

// Smooth weighted round robin (as nginx): over time each printer gets its weight's share, interleaved.
type Balancer struct {
	mu      sync.Mutex
	current map[string]int
	resting map[string]time.Time // printers that just failed sit out a minute
}

func (b *Balancer) pick(printers []SysPrinter, prefs map[string]Preference) (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.current == nil {
		b.current, b.resting = map[string]int{}, map[string]time.Time{}
	}
	total, best := 0, ""
	for _, p := range printers {
		pref, ok := prefs[p.Name]
		if !ok || !pref.documents() || p.Status == "offline" || p.Status == "error" || p.Status == "paused" {
			continue
		}
		if until, resting := b.resting[p.Name]; resting && time.Now().Before(until) {
			continue
		}
		weight := pref.Weight
		if weight < 1 {
			weight = 1
		}
		b.current[p.Name] += weight
		total += weight
		if best == "" || b.current[p.Name] > b.current[best] {
			best = p.Name
		}
	}
	if best == "" {
		return "", false
	}
	b.current[best] -= total
	return best, true
}

// How many printers can take a job right now: enabled, working and not resting after a failure.
func (b *Balancer) available(printers []SysPrinter, prefs map[string]Preference) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, p := range printers {
		pref, ok := prefs[p.Name]
		if !ok || !pref.documents() || p.Status == "offline" || p.Status == "error" || p.Status == "paused" {
			continue
		}
		if until, resting := b.resting[p.Name]; resting && time.Now().Before(until) {
			continue
		}
		n++
	}
	return n
}

// Receipt printers that can print a ticket now.
func receiptPrinters(printers []SysPrinter, prefs map[string]Preference) int {
	n := 0
	for _, p := range printers {
		if pref, ok := prefs[p.Name]; ok && pref.Enabled && pref.Kind == "receipt" && p.Status != "offline" && p.Status != "error" && p.Status != "paused" {
			n++
		}
	}
	return n
}

func (b *Balancer) rest(name string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.resting == nil {
		b.resting = map[string]time.Time{}
	}
	b.resting[name] = time.Now().Add(time.Minute)
}

func usable(printers []SysPrinter, prefs map[string]Preference) int {
	n := 0
	for _, p := range printers {
		if pref, ok := prefs[p.Name]; ok && pref.documents() && p.Status != "offline" && p.Status != "error" && p.Status != "paused" {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------- Running

func run(client *Client, paper Paper) error {
	host, _ := os.Hostname()
	system := systemName()
	var (
		stateMu  sync.Mutex
		printers []SysPrinter
		reply    heartbeatReply
		balancer Balancer
		lastBeat time.Time
		lastWarn string
	)
	beat := func() error {
		list, err := allPrinters()
		stateMu.Lock()
		if err != nil {
			if err.Error() != lastWarn {
				logf("读取打印机失败：%v", err)
				lastWarn = err.Error()
			}
		} else {
			printers = list
		}
		currentPrinters := append([]SysPrinter(nil), printers...)
		prevReply := reply
		firstBeat := lastBeat.IsZero()
		stateMu.Unlock()

		var next heartbeatReply
		// "receipt": this client prints balloon tickets, so the server may use its receipt printers.
		if err := client.call("heartbeat", map[string]any{"version": version, "host": host, "os": system, "printers": currentPrinters, "capabilities": []string{"receipt"}}, &next); err != nil {
			return err
		}
		if next.Name != prevReply.Name || next.Enabled != prevReply.Enabled || firstBeat {
			state := "已启用"
			if !next.Enabled {
				state = "已在管理页停用，暂不领取打印请求"
			}
			logf("已连接打印服务器“%s”（%s），本机 %d 台打印机，%d 台参与打印，%d 台小票机", next.Name, state, len(currentPrinters), usable(currentPrinters, next.Preferences), receiptPrinters(currentPrinters, next.Preferences))
		}
		stateMu.Lock()
		reply = next
		lastBeat = time.Now()
		stateMu.Unlock()
		return nil
	}
	if err := beat(); err != nil {
		return err
	}
	// Keep heartbeats flowing while long print/report batches run so Hydro does not mark this PC offline.
	stopBeat := make(chan struct{})
	unauthCh := make(chan error, 1)
	defer close(stopBeat)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopBeat:
				return
			case <-ticker.C:
				stateMu.Lock()
				stale := time.Since(lastBeat) >= 10*time.Second
				stateMu.Unlock()
				if !stale {
					continue
				}
				if err := beat(); errors.Is(err, errUnauthorized) {
					select {
					case unauthCh <- err:
					default:
					}
					return
				}
			}
		}
	}()
	failures := 0
	for {
		select {
		case err := <-unauthCh:
			return err
		default:
		}
		stateMu.Lock()
		needBeat := time.Since(lastBeat) > 10*time.Second
		stateMu.Unlock()
		if needBeat {
			if err := beat(); err != nil {
				if errors.Is(err, errUnauthorized) {
					return err
				}
				failures++
				logf("%v（%d 秒后重试）", err, min(30, failures*3))
				time.Sleep(time.Duration(min(30, failures*3)) * time.Second)
				continue
			}
		}
		stateMu.Lock()
		currentPrinters := append([]SysPrinter(nil), printers...)
		currentReply := reply
		stateMu.Unlock()

		poll := time.Duration(currentReply.PollMs) * time.Millisecond
		if poll < time.Second {
			poll = 3 * time.Second
		}
		// Only printers that can print now: one resting after a failure takes no new jobs.
		slots := balancer.available(currentPrinters, currentReply.Preferences)
		// Receipt printers take balloon tickets also when no printer is free for printouts.
		if !currentReply.Enabled || (slots == 0 && receiptPrinters(currentPrinters, currentReply.Preferences) == 0) {
			time.Sleep(poll)
			continue
		}
		var next struct {
			Jobs []Job `json:"jobs"`
		}
		if err := client.call("next", map[string]any{"slots": slots, "receipts": true}, &next); err != nil {
			if errors.Is(err, errUnauthorized) {
				return err
			}
			failures++
			logf("领取打印请求失败：%v", err)
			time.Sleep(time.Duration(min(30, failures*3)) * time.Second)
			continue
		}
		failures = 0
		released := false
		type assignedJob struct {
			printer string
			job     Job
		}
		byPrinter := map[string][]assignedJob{}
		var printerOrder []string
		addAssigned := func(printer string, job Job) {
			if _, ok := byPrinter[printer]; !ok {
				printerOrder = append(printerOrder, printer)
			}
			byPrinter[printer] = append(byPrinter[printer], assignedJob{printer: printer, job: job})
		}
		for _, job := range next.Jobs {
			if job.Kind == "receipt" {
				addAssigned(job.Printer, job)
				continue
			}
			printer := job.Printer
			if printer == "" || !hasPrinter(currentPrinters, printer) {
				var ok bool
				if printer, ok = balancer.pick(currentPrinters, currentReply.Preferences); !ok {
					// Not this request's fault: hand it back without using up one of its attempts.
					released = true
					report(client, map[string]any{"id": job.ID, "status": "released", "message": "没有可用的打印机"})
					continue
				}
			}
			addAssigned(printer, job)
		}
		// Dispatch distinct printers concurrently while keeping each individual printer serialized.
		var wg sync.WaitGroup
		for _, pName := range printerOrder {
			batch := byPrinter[pName]
			wg.Add(1)
			go func(items []assignedJob) {
				defer wg.Done()
				for _, item := range items {
					job := item.job
					if job.Kind == "receipt" {
						result := map[string]any{"id": job.ID, "printer": job.Printer, "status": "printed"}
						start := time.Now()
						var err error
						if !hasPrinter(currentPrinters, job.Printer) {
							err = fmt.Errorf("本机没有小票机 %s", job.Printer)
						} else {
							err = printReceipt(job.Printer, job)
						}
						if err != nil {
							result["status"], result["message"] = "failed", err.Error()
							logf("小票打印失败  %s → %s：%v", job.Title, job.Printer, err)
						} else {
							logf("已打印小票  %s → %s（%.1f 秒）", job.Title, job.Printer, time.Since(start).Seconds())
						}
						if err := report(client, result); err != nil {
							logf("回报结果失败：%v", err)
						}
						continue
					}
					start := time.Now()
					err := printTo(item.printer, job, paper)
					result := map[string]any{"id": job.ID, "printer": item.printer, "status": "printed"}
					if err != nil {
						balancer.rest(item.printer)
						result["status"], result["message"] = "failed", err.Error()
						logf("打印失败  %s → %s：%v", job.Title, item.printer, err)
					} else {
						logf("已打印  %s → %s（%.1f 秒）", job.Title, item.printer, time.Since(start).Seconds())
					}
					if err := report(client, result); err != nil {
						logf("回报结果失败：%v", err)
					}
				}
			}(batch)
		}
		wg.Wait()
		if len(next.Jobs) == 0 || released {
			time.Sleep(poll)
		}
	}
}

// reportRetries spaces the attempts to report a result. A printout whose result never reaches Hydro
// goes back to the queue after five minutes and is printed again, so a short outage must not lose it.
var reportRetries = []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second}

func report(client *Client, body map[string]any) error {
	var err error
	for attempt := 0; ; attempt++ {
		if err = client.call("report", body, nil); err == nil {
			return nil
		}
		var refused refusedError
		if errors.Is(err, errUnauthorized) || errors.As(err, &refused) || attempt >= len(reportRetries) {
			return err
		}
		logf("回报结果失败：%v（%d 秒后重试）", err, int(reportRetries[attempt].Seconds()))
		time.Sleep(reportRetries[attempt])
	}
}

// Folder printers (--to-folder) save each printout as a PDF instead of printing: for trying the
// setup without paper, or keeping copies.
var folder string
var folderCount int

func folderPrinters() []SysPrinter {
	var list []SysPrinter
	for i := 1; i <= folderCount; i++ {
		list = append(list, SysPrinter{Name: fmt.Sprintf("保存到文件夹 %d", i), Status: "idle", Message: folder})
	}
	return list
}

func allPrinters() ([]SysPrinter, error) {
	list, err := listPrinters()
	if folder != "" {
		return append(list, folderPrinters()...), nil
	}
	return list, err
}

var folderSeq atomic.Uint64

func folderOutputBase(printer string, job Job) string {
	tag := job.ID
	if tag == "" {
		tag = fmt.Sprintf("n%d", folderSeq.Add(1))
	}
	return safeName.ReplaceAllString(fmt.Sprintf("%s-%s-%s-%s", time.Now().Format("150405"), strings.TrimPrefix(printer, "保存到文件夹 "), tag, job.Title), "_")
}

func printTo(printer string, job Job, paper Paper) error {
	if folder != "" && strings.HasPrefix(printer, "保存到文件夹 ") {
		name := folderOutputBase(printer, job)
		return os.WriteFile(filepath.Join(folder, name+".pdf"), WritePDF(Layout(job, paper), paper, job.Title), 0o644)
	}
	return printOn(printer, job, paper)
}

func hasPrinter(printers []SysPrinter, name string) bool {
	for _, p := range printers {
		if p.Name == name {
			return true
		}
	}
	return false
}

func prompt(reader *bufio.Reader) (Connection, error) {
	for {
		fmt.Print("\n请粘贴“打印服务器管理”中复制的连接信息，然后按回车：\n> ")
		line, err := reader.ReadString('\n')
		if strings.TrimSpace(line) == "" && err != nil {
			return Connection{}, errors.New("没有输入连接信息")
		}
		conn, perr := parseCode(line)
		if perr == nil {
			return conn, nil
		}
		fmt.Println(perr)
	}
}

func main() {
	connect := flag.String("connect", "", "使用连接信息连接（保存后下次直接运行即可）")
	reset := flag.Bool("reset", false, "清除已保存的连接信息")
	list := flag.Bool("printers", false, "列出本机打印机后退出")
	sample := flag.String("sample", "", "把打印样张写入 PDF 文件后退出（检查排版）")
	samplePrint := flag.String("print-sample", "", "在指定打印机上打印样张后退出")
	paperName := flag.String("paper", "", "纸张：A4（默认）或 Letter，仅 macOS、Linux；Windows 使用打印机的纸张")
	insecure := flag.Bool("insecure", false, "不校验 HTTPS 证书（自签名证书时使用）")
	showVersion := flag.Bool("version", false, "显示版本")
	flag.StringVar(&folder, "to-folder", "", "另外提供“保存到文件夹”打印机，把打印内容存为 PDF（试运行或留档）")
	flag.IntVar(&folderCount, "folder-printers", 1, "“保存到文件夹”打印机的数量（试验负载均衡）")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Hydro 打印客户端 %s\n\n直接运行，按提示粘贴连接信息即可。可选参数：\n", version)
		flag.PrintDefaults()
	}
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	fmt.Printf("Hydro 打印客户端 %s · %s · %s/%s\n", version, systemName(), runtime.GOOS, runtime.GOARCH)
	exit := func(code int) {
		waitBeforeExit()
		os.Exit(code)
	}
	if folder != "" {
		if err := os.MkdirAll(folder, 0o755); err != nil {
			fmt.Println(err)
			exit(1)
		}
	}
	if *list {
		printers, err := allPrinters()
		if err != nil {
			fmt.Println(err)
			exit(1)
		}
		if len(printers) == 0 {
			fmt.Println("本机没有打印机。请先在系统设置中添加打印机。")
		}
		for _, p := range printers {
			mark := ""
			if p.IsDefault {
				mark = "（默认）"
			}
			fmt.Printf("  %s%s  状态 %s  排队 %d  %s\n", p.Name, mark, p.Status, p.Queue, p.Message)
		}
		exit(0)
	}
	path := configPath()
	config, saved := loadConfig(path)
	// Flags override the saved choices and are saved with them.
	changed := false
	if *paperName != "" {
		choice := "A4"
		if strings.EqualFold(*paperName, "letter") {
			choice = "Letter"
		} else if !strings.EqualFold(*paperName, "a4") {
			fmt.Println("纸张只能是 A4 或 Letter")
			exit(1)
		}
		if config.Paper != choice {
			config.Paper, changed = choice, true
		}
	}
	insecureSet := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "insecure" {
			insecureSet = true
		}
	})
	if insecureSet && config.Insecure != *insecure {
		config.Insecure, changed = *insecure, true
	}
	paper := A4
	if strings.EqualFold(config.Paper, "letter") {
		paper = Letter
	}
	if *sample != "" {
		if err := os.WriteFile(*sample, WritePDF(Layout(sampleJob(), paper), paper, "打印样张"), 0o644); err != nil {
			fmt.Println(err)
			exit(1)
		}
		fmt.Println("已写入", *sample)
		return
	}
	if *samplePrint != "" {
		if err := printOn(*samplePrint, sampleJob(), paper); err != nil {
			fmt.Println("打印失败：", err)
			exit(1)
		}
		fmt.Println("已发送样张到", *samplePrint)
		exit(0)
	}
	if *reset {
		os.Remove(path)
		fmt.Println("已清除连接信息")
		exit(0)
	}
	reader := bufio.NewReader(os.Stdin)
	if *connect != "" {
		conn, err := parseCode(*connect)
		if err != nil {
			fmt.Println(err)
			exit(1)
		}
		config.Connection, saved = conn, false
	} else if !saved {
		conn, err := prompt(reader)
		if err != nil {
			fmt.Println(err)
			exit(1)
		}
		config.Connection = conn
	}
	for {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		if config.Insecure {
			transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		}
		client := &Client{conn: config.Connection, http: &http.Client{
			Timeout:   30 * time.Second,
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}}
		if !saved || changed {
			if err := saveConfig(path, config); err == nil {
				fmt.Println("连接信息已保存到", path)
				saved, changed = true, false
			}
		}
		fmt.Printf("连接 %s …\n", config.URL)
		err := run(client, paper)
		if errors.Is(err, errUnauthorized) {
			fmt.Println("连接信息无效或已在管理页重新生成。")
			os.Remove(path)
			conn, perr := prompt(reader)
			if perr != nil {
				exit(1)
			}
			config.Connection, saved = conn, false
			continue
		}
		fmt.Println(err)
		fmt.Println("10 秒后重新连接…")
		time.Sleep(10 * time.Second)
	}
}
