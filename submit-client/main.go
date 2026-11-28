package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

var version = "dev"

const usage = `submit 文件 [-p 题号] [-l 语言] [--tid 比赛编号]
submit print 文件 [--tid 比赛编号]
submit info | submit status [--tid 比赛编号]
submit install [--server 比赛站点地址] [--dir 安装目录]`

type options struct{ action, file, problem, lang, tid, server, dir string }

func parseArgs(args []string) (options, error) {
	o := options{action: "submit"}
	if len(args) == 0 {
		return o, errors.New(usage)
	}
	switch args[0] {
	case "info", "status", "print", "install":
		o.action = args[0]
		args = args[1:]
	case "help", "-h", "--help":
		o.action = "help"
		return o, nil
	case "--version":
		o.action = "version"
		return o, nil
	}
	flags := map[string]*string{"-p": &o.problem, "-l": &o.lang, "--tid": &o.tid, "--dir": &o.dir, "--server": &o.server}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if flag, ok := flags[arg]; ok {
			if i+1 >= len(args) || args[i+1] == "" || strings.HasPrefix(args[i+1], "-") {
				return o, fmt.Errorf("%s 缺少参数", arg)
			}
			*flag = args[i+1]
			i++
		} else if strings.HasPrefix(arg, "-") {
			return o, fmt.Errorf("未知选项 %s", arg)
		} else if o.file != "" {
			return o, errors.New("每次只能指定一个文件")
		} else {
			o.file = arg
		}
	}
	fileCommand := o.action == "submit" || o.action == "print"
	if fileCommand != (o.file != "") {
		return o, errors.New(usage)
	}
	if (o.problem != "" || o.lang != "") && o.action != "submit" || o.dir != "" && o.action != "install" || o.tid != "" && (o.action == "info" || o.action == "install") {
		return o, errors.New(usage)
	}
	return o, nil
}

func sourceFile(name string) (string, error) {
	f, err := os.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !stat.Mode().IsRegular() {
		return "", errors.New("请选择普通源文件")
	}
	raw, err := io.ReadAll(f)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(raw) || strings.TrimSpace(string(raw)) == "" {
		return "", errors.New("请使用非空 UTF-8 文本文件")
	}
	return string(raw), nil
}

func run(args []string, out io.Writer) error {
	o, err := parseArgs(args)
	if err != nil {
		return err
	}
	switch o.action {
	case "help":
		fmt.Fprintln(out, usage)
		return nil
	case "version":
		fmt.Fprintln(out, version)
		return nil
	}
	base, err := configuredServer(o.server)
	if err != nil {
		return err
	}
	if o.action == "install" {
		return install(base, o.dir, out)
	}
	api := newClient(base)
	if o.action == "status" {
		var result records
		if err := api.request("status", o.tid, nil, &result); err != nil {
			return err
		}
		if result.Hidden {
			fmt.Fprintln(out, "本场比赛暂不公开评测记录")
			return nil
		}
		if len(result.Records) == 0 {
			fmt.Fprintln(out, "暂无提交")
			return nil
		}
		for _, r := range result.Records {
			fmt.Fprintf(out, "%s  %s  %s  %s %s\n", r.Rid, r.Problem, r.Lang, r.Code, r.Text)
		}
		return nil
	}
	if o.action == "print" {
		code, err := sourceFile(o.file)
		if err != nil {
			return err
		}
		var r receipt
		if err := api.request("print", "", map[string]string{"tid": o.tid, "filename": filepath.Base(o.file), "code": code}, &r); err != nil {
			return err
		}
		if !r.Queued {
			return errors.New("打印服务器未返回回执")
		}
		fmt.Fprintf(out, "已加入打印队列：%s\n", r.Filename)
		return nil
	}
	var i info
	if err := api.request("info", "", nil, &i); err != nil {
		return err
	}
	if i.Account.UID <= 0 {
		return errors.New("比赛服务器未确认绑定账号")
	}
	if o.action == "info" {
		fmt.Fprintf(out, "本机账号：%s（%d）\n", i.Account.Name, i.Account.UID)
		if len(i.Contests) == 0 {
			fmt.Fprintln(out, "没有进行中的比赛")
		}
		for _, c := range i.Contests {
			fmt.Fprintf(out, "%s  %s\n", c.Tid, c.Title)
			for _, p := range c.Problems {
				var langs []string
				for _, l := range p.Languages {
					langs = append(langs, l.Key)
				}
				fmt.Fprintf(out, "  %s  %s\n", p.Label, strings.Join(langs, ", "))
			}
		}
		return nil
	}
	c, err := i.choose(o.tid)
	if err != nil {
		return err
	}
	p, l, err := submissionTarget(c, o.file, o.problem, o.lang)
	if err != nil {
		return err
	}
	code, err := sourceFile(o.file)
	if err != nil {
		return err
	}
	var r receipt
	if err := api.request("submit", "", map[string]string{"tid": c.Tid, "problem": p, "lang": l, "filename": filepath.Base(o.file), "code": code}, &r); err != nil {
		return err
	}
	if !r.Submitted {
		return errors.New("评测服务器未返回提交回执")
	}
	fmt.Fprintf(out, "已提交 %s %s\n", r.Problem, r.Rid)
	return nil
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
