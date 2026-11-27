package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type language struct{ Key, Display, Ext string }
type problem struct {
	Label     string
	Languages []language
}
type contest struct {
	Tid, Title string
	CanPrint   bool
	Problems   []problem
}
type info struct {
	Account struct {
		UID  int
		Name string
	}
	Contests []contest
}
type record struct{ Rid, Problem, Lang, Code, Text string }
type records struct {
	Hidden  bool
	Records []record
}
type receipt struct {
	Rid, Problem, Filename string
	Submitted, Queued      bool
}

func serverURL(value string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return "", errors.New("服务器地址必须是带 http(s) 的比赛站点地址，可含 /d/域名")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

type apiClient struct {
	base  string
	http  *http.Client
	delay time.Duration
}

func newClient(base string) *apiClient {
	// Connect from the workstation itself. An HTTP proxy may have a different IP binding.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	// Never retain cookies or follow a redirect carrying source code.
	return &apiClient{base: base, http: &http.Client{Transport: transport, Timeout: 25 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}, delay: 250 * time.Millisecond}
}

func (c *apiClient) request(action, tid string, data, out any) error {
	endpoint := c.base + "/xcpcio-submit/" + action
	var payload []byte
	method := http.MethodGet
	if data != nil {
		var err error
		payload, err = json.Marshal(data)
		if err != nil {
			return err
		}
		method = http.MethodPost
	} else if tid != "" {
		endpoint += "?" + url.Values{"tid": {tid}}.Encode()
	}
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequest(method, endpoint, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "Hydro-submit/"+version)
		if data != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return fmt.Errorf("连接比赛服务器失败：%w", err)
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusConflict && attempt < 2 {
			time.Sleep(time.Duration(attempt+1) * c.delay)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			var detail struct {
				Error   struct{ Message string }
				Message string
			}
			_ = json.Unmarshal(raw, &detail)
			msg := detail.Error.Message
			if msg == "" {
				msg = detail.Message
			}
			if msg == "" {
				msg = resp.Status
			}
			return fmt.Errorf("HTTP %d：%s", resp.StatusCode, msg)
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("服务器未返回有效的 submit JSON：%w", err)
		}
		return nil
	}
	return errors.New("比赛服务器未能确认 IP 账号")
}

func (i info) choose(tid string) (contest, error) {
	if tid == "" && len(i.Contests) == 1 {
		return i.Contests[0], nil
	}
	if len(i.Contests) == 0 {
		return contest{}, errors.New("本机账号没有进行中的比赛")
	}
	for _, c := range i.Contests {
		if c.Tid == tid {
			return c, nil
		}
	}
	if tid == "" {
		return contest{}, errors.New("同时参加多场比赛，请运行 submit info 并用 --tid 指定比赛编号")
	}
	return contest{}, errors.New("指定比赛未在进行，或本机账号没有参加")
}

var filenameLabel = regexp.MustCompile(`(?i)^([a-z]+)($|[-_.])`)

func submissionTarget(c contest, file, label, lang string) (string, string, error) {
	base := filepath.Base(file)
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(base)), ".")
	if label == "" {
		stem := strings.TrimSuffix(base, filepath.Ext(base))
		if m := filenameLabel.FindStringSubmatch(stem); m != nil {
			label = m[1]
		}
	}
	for _, p := range c.Problems {
		if !strings.EqualFold(p.Label, label) {
			continue
		}
		if len(p.Languages) == 1 && p.Languages[0].Key == "_" && (lang == "" || lang == "_") {
			return p.Label, "_", nil
		}
		for _, l := range p.Languages {
			if strings.EqualFold(lang, l.Key) {
				return p.Label, l.Key, nil
			}
		}
		wanted := strings.ToLower(lang)
		if wanted == "" {
			wanted = ext
		}
		switch wanted {
		case "cc", "cxx", "c++":
			wanted = "cpp"
		case "pyw":
			wanted = "py"
		}
		for _, l := range p.Languages {
			if wanted != "" && (strings.EqualFold(wanted, l.Ext) || strings.EqualFold(wanted, l.Key)) {
				return p.Label, l.Key, nil
			}
		}
		var choices []string
		for _, l := range p.Languages {
			choices = append(choices, l.Key)
		}
		return "", "", fmt.Errorf("题目 %s 无法使用此语言，请用 -l 指定：%s", p.Label, strings.Join(choices, ", "))
	}
	return "", "", errors.New("文件名无法对应比赛题号，请用 -p 指定，例如 -p B")
}
