package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const configName = "submit-server.json"

type config struct {
	Server string `json:"server"`
}

func configuredServer(explicit string) (string, error) {
	if explicit != "" {
		return serverURL(explicit)
	}
	if env := os.Getenv("HYDRO_SUBMIT_SERVER"); env != "" {
		return serverURL(env)
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(exe), configName))
	if err != nil {
		return "", fmt.Errorf("未找到服务器配置，请解压比赛提供的完整安装包，或用 --server 指定地址：%w", err)
	}
	var cfg config
	if err = json.Unmarshal(raw, &cfg); err != nil {
		return "", err
	}
	return serverURL(cfg.Server)
}

func writableDir(dir string) bool {
	if !filepath.IsAbs(dir) {
		return false
	}
	tmp, err := os.CreateTemp(dir, ".submit-write-*")
	if err != nil {
		return false
	}
	tmp.Close()
	os.Remove(tmp.Name())
	return true
}

func inPath(dir string) bool {
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		if runtime.GOOS == "windows" {
			if strings.EqualFold(filepath.Clean(dir), filepath.Clean(p)) {
				return true
			}
		} else if filepath.Clean(dir) == filepath.Clean(p) {
			return true
		}
	}
	return false
}

func installDirectory(requested string) (string, error) {
	if requested != "" {
		return filepath.Abs(requested)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	userBin := filepath.Join(home, ".local", "bin")
	if runtime.GOOS == "windows" {
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		userBin = filepath.Join(local, "Hydro", "bin")
	}
	candidates := []string{userBin}
	if runtime.GOOS != "windows" {
		candidates = append(candidates, "/usr/local/bin", "/opt/homebrew/bin")
	}
	// Also honor a writable bin supplied by the venue on PATH (e.g. /opt/contest/bin).
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		clean := filepath.Clean(p)
		if filepath.IsAbs(clean) && filepath.Base(clean) == "bin" && clean != "/bin" && clean != "/usr/bin" && clean != filepath.Join(runtime.GOROOT(), "bin") {
			candidates = append(candidates, p)
		}
	}
	for _, p := range candidates {
		if inPath(p) && writableDir(p) {
			return p, nil
		}
	}
	return userBin, nil
}

func addUserPath(dir string) error {
	if inPath(dir) {
		return nil
	}
	if runtime.GOOS == "windows" {
		// Fixed PowerShell code; the chosen directory is passed as data (it may contain quotes).
		const command = `$d=$env:HYDRO_SUBMIT_BINDIR;$p=[Environment]::GetEnvironmentVariable('Path','User');if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('Path',(($p+';'+$d).Trim(';')),'User')}`
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)
		cmd.Env = append(os.Environ(), "HYDRO_SUBMIT_BINDIR="+dir)
		return cmd.Run()
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	// Quote a shell literal for login profiles. Fish gets its native configuration syntax.
	quoted := "'" + strings.ReplaceAll(dir, "'", "'\"'\"'") + "'"
	profile := ".profile"
	line := "export PATH=" + quoted + ":\"$PATH\""
	switch filepath.Base(os.Getenv("SHELL")) {
	case "zsh":
		profile = ".zshrc"
	case "bash":
		profile = ".bashrc"
	case "fish":
		profile = filepath.Join(".config", "fish", "conf.d", "hydro-submit.fish")
		fishQuoted := "'" + strings.NewReplacer("\\", "\\\\", "'", "\\'").Replace(dir) + "'"
		line = "fish_add_path " + fishQuoted
	}
	filename := filepath.Join(home, profile)
	if err := os.MkdirAll(filepath.Dir(filename), 0755); err != nil {
		return err
	}
	existing, err := os.ReadFile(filename)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, old := range strings.Split(string(existing), "\n") {
		if old == line {
			return nil
		}
	}
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(file, "\n%s\n", line)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func atomicCopy(target string, src io.Reader, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(target), ".submit-install-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = io.Copy(tmp, src); err == nil {
		err = tmp.Chmod(mode)
	}
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp.Name(), target)
}

func install(base, requested string, out io.Writer) error {
	dir, err := installDirectory(requested)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	source, err := os.Executable()
	if err != nil {
		return err
	}
	binary := "submit"
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	target := filepath.Join(dir, binary)
	configFile := filepath.Join(dir, configName)
	current, err := os.Stat(source)
	if err != nil {
		return err
	}
	dest, err := os.Stat(target)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if dest == nil || !os.SameFile(current, dest) {
		if dest != nil {
			raw, err := os.ReadFile(configFile)
			var prior config
			if err != nil || json.Unmarshal(raw, &prior) != nil || prior.Server == "" {
				return errors.New("安装目录已有同名程序，请用 --dir 选择其他目录")
			}
		}
		file, err := os.Open(source)
		if err != nil {
			return err
		}
		defer file.Close()
		if err := atomicCopy(target, file, 0755); err != nil {
			return err
		}
	}
	raw, err := json.Marshal(config{Server: base})
	if err != nil {
		return err
	}
	if err := atomicCopy(configFile, strings.NewReader(string(raw)+"\n"), 0644); err != nil {
		return err
	}
	if err := addUserPath(dir); err != nil {
		return fmt.Errorf("已安装到 %s，添加到 PATH 失败：%w", dir, err)
	}
	fmt.Fprintf(out, "已安装到 %s\n服务器：%s\n", target, base)
	if !inPath(dir) {
		fmt.Fprintln(out, "重新打开终端后即可使用 submit。")
	}
	return nil
}
