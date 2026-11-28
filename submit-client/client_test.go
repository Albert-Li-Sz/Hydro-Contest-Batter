package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestFileTargetsAndArgs(t *testing.T) {
	c := contest{Problems: []problem{{Label: "B", Languages: []language{{Key: "cc.cc17o2", Ext: "cpp"}, {Key: "py3", Ext: "py"}}}, {Label: "AA", Languages: []language{{Key: "_", Ext: ""}}}}}
	for _, tc := range []struct{ file, p, l, wp, wl string }{
		{"b.cpp", "", "", "B", "cc.cc17o2"}, {"b.cc", "", "", "B", "cc.cc17o2"}, {"solution.unknown", "b", "cpp", "B", "cc.cc17o2"},
		{"solution.cpp", "B", "py3", "B", "py3"}, {"B-main.py", "", "", "B", "py3"}, {"aa.txt", "", "", "AA", "_"},
	} {
		p, l, err := submissionTarget(c, tc.file, tc.p, tc.l)
		if err != nil || p != tc.wp || l != tc.wl {
			t.Fatalf("%+v: %s %s %v", tc, p, l, err)
		}
	}
	if _, _, err := submissionTarget(c, "secret.cpp", "", ""); err == nil {
		t.Fatal("unknown label accepted")
	}
	if _, _, err := submissionTarget(c, "B.java", "", "java"); err == nil {
		t.Fatal("disallowed language accepted")
	}
	o, err := parseArgs([]string{"sol.cpp", "-p", "B", "-l", "cpp", "--tid", "abc"})
	if err != nil || o.file != "sol.cpp" || o.problem != "B" || o.lang != "cpp" || o.tid != "abc" {
		t.Fatalf("args: %+v %v", o, err)
	}
	for _, args := range [][]string{{"status", "a.cpp"}, {"print"}, {"info", "-l", "cpp"}, {"a.cpp", "extra.cpp"}, {"-p"}} {
		if _, err := parseArgs(args); err == nil {
			t.Errorf("invalid args accepted: %q", args)
		}
	}
	i := info{Contests: []contest{{Tid: "a"}, {Tid: "b"}}}
	if _, err := i.choose(""); err == nil {
		t.Fatal("ambiguous contests accepted")
	}
	if got, err := i.choose("b"); err != nil || got.Tid != "b" {
		t.Fatal(got, err)
	}
}

func TestIPRetryKeepsPOSTAndNeverUsesCookie(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if r.URL.Path != "/d/arena/xcpcio-submit/submit" || r.Method != "POST" || r.Header.Get("Accept") != "application/json" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("sent credentials")
		}
		var input map[string]string
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || !reflect.DeepEqual(input, map[string]string{"code": "int main(){}"}) {
			t.Error(input, err)
		}
		w.Header().Set("Set-Cookie", "sid=preview; Path=/")
		if attempts == 1 {
			w.WriteHeader(409)
			fmt.Fprint(w, `{"error":{"message":"IP login changed"}}`)
			return
		}
		fmt.Fprint(w, `{"submitted":true,"rid":"123"}`)
	}))
	defer srv.Close()
	c := newClient(srv.URL + "/d/arena")
	c.delay = 0
	var r receipt
	if err := c.request("submit", "", map[string]string{"code": "int main(){}"}, &r); err != nil || !r.Submitted || r.Rid != "123" || attempts != 2 {
		t.Fatal(r, attempts, err)
	}
}

func TestRejectRedirectAndBoundRetries(t *testing.T) {
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits++ }))
	defer target.Close()
	for _, tc := range []struct{ status, want int }{{307, 1}, {403, 1}, {409, 3}, {500, 1}} {
		count := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			count++
			w.Header().Set("Location", target.URL)
			w.WriteHeader(tc.status)
		}))
		c := newClient(srv.URL)
		c.delay = 0
		err := c.request("submit", "", map[string]string{"code": "example"}, &receipt{})
		srv.Close()
		if err == nil || count != tc.want {
			t.Errorf("%d: count %d, err %v", tc.status, count, err)
		}
	}
	if hits != 0 {
		t.Fatal("redirect target was contacted")
	}
	for _, raw := range []string{"file:///tmp/x", "http://name:password@site", "https://x/?q=z", "https://x/#a"} {
		if _, err := serverURL(raw); err == nil {
			t.Errorf("invalid URL accepted: %s", raw)
		}
	}
}

func TestInstallInExistingPath(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	if err := install("https://oj.example/d/demo", dir, io.Discard); err != nil {
		t.Fatal(err)
	}
	name := "submit"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, configName))
	if err != nil || !strings.Contains(string(raw), "https://oj.example/d/demo") {
		t.Fatal(string(raw), err)
	}
	if err := install("https://other.example/d/demo", dir, io.Discard); err != nil {
		t.Fatal(err)
	}
	unrelated := t.TempDir()
	if err := os.WriteFile(filepath.Join(unrelated, name), []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := install("https://oj.example/d/demo", unrelated, io.Discard); err == nil {
		t.Fatal("replaced unrelated executable")
	}
}
