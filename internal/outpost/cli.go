package outpost

import (
	"bytes"
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
	"strings"
	"syscall"
	"time"
)

type Versions struct {
	Host     string `json:"host"`
	SDK      string `json:"sdk"`
	Plugin   string `json:"plugin"`
	Daemon   string `json:"daemon"`
	Protocol int    `json:"protocol"`
}

type Connection struct {
	Instance      string            `json:"instance"`
	CompanyID     string            `json:"companyId"`
	OutpostID     string            `json:"outpostId"`
	EnvironmentID string            `json:"environmentId"`
	Name          string            `json:"name"`
	Credential    string            `json:"credential"`
	WorkspaceRoot string            `json:"workspaceRoot"`
	ScratchRoot   string            `json:"scratchRoot"`
	Headers       map[string]string `json:"headers,omitempty"`
	RuntimeRoots  []string          `json:"runtimeRoots,omitempty"`
	RuntimeEnv    []string          `json:"runtimeEnv,omitempty"`
}
type enrollment struct {
	OperatorAuthorization string            `json:"operatorAuthorization"`
	Headers               map[string]string `json:"headers"`
	RuntimeRoots          []string          `json:"runtimeRoots,omitempty"`
	RuntimeEnv            []string          `json:"runtimeEnv,omitempty"`
}

func Run(args []string, input io.Reader, output io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: outpost register|connect|daemon|diagnose")
	}
	f := flag.NewFlagSet(args[0], flag.ContinueOnError)
	f.SetOutput(io.Discard)
	privateDir := f.String("private-dir", "", "private connection directory")
	instance := f.String("instance", "", "Paperclip origin")
	company := f.String("company", "", "Paperclip company ID")
	name := f.String("name", "", "outpost name")
	workspace := f.String("workspace-root", "", "agent-writable workspace root")
	scratch := f.String("scratch-root", "", "agent-writable scratch root")
	if f.Parse(args[1:]) != nil || (f.NArg() != 0 && args[0] != "protect") {
		return errors.New("invalid command arguments")
	}
	if args[0] == "register" {
		if *company == "" || *name == "" {
			return errors.New("company and name are required")
		}
		origin, err := validateOrigin(*instance)
		if err != nil {
			return err
		}
		if err := preparePrivate(*privateDir, *workspace, *scratch); err != nil {
			return err
		}
		var auth enrollment
		if err := decode(input, &auth); err != nil {
			return errors.New("registration requires operator authentication JSON on stdin")
		}
		if !strings.HasPrefix(auth.OperatorAuthorization, "Bearer ") {
			return errors.New("operator bearer authentication is required")
		}
		if err := validateHeaders(auth.Headers); err != nil {
			return err
		}
		if err := validateRuntimeEnv(auth.RuntimeEnv); err != nil {
			return err
		}
		var result struct {
			OutpostID  string   `json:"outpostId"`
			Credential string   `json:"credential"`
			Versions   Versions `json:"versions"`
		}
		if err := request(origin, "/api/plugins/yelqo.outpost/api/outposts", map[string]string{"companyId": *company, "name": *name}, auth, &result); err != nil {
			return err
		}
		if result.Versions != supported || result.Credential == "" || result.OutpostID == "" {
			return errors.New("registration returned an incompatible connection contract")
		}
		var environment struct {
			ID string `json:"id"`
		}
		err = request(origin, "/api/companies/"+url.PathEscape(*company)+"/environments", map[string]any{
			"name": *name, "driver": "sandbox", "config": map[string]any{"provider": "outpost", "outpostId": result.OutpostID, "companyId": *company},
		}, auth, &environment)
		if err != nil {
			revoke(origin, *company, result.OutpostID, auth)
			return err
		}
		c := Connection{Instance: origin, CompanyID: *company, OutpostID: result.OutpostID, EnvironmentID: environment.ID, Name: *name, Credential: result.Credential, WorkspaceRoot: *workspace, ScratchRoot: *scratch, Headers: auth.Headers, RuntimeRoots: auth.RuntimeRoots, RuntimeEnv: auth.RuntimeEnv}
		if err := validateRuntimeRoots(*privateDir, c); err != nil {
			revoke(origin, *company, result.OutpostID, auth)
			return err
		}
		if err := save(*privateDir, c); err != nil {
			revoke(origin, *company, result.OutpostID, auth)
			return err
		}
		return json.NewEncoder(output).Encode(map[string]string{"outpostId": c.OutpostID, "environmentId": c.EnvironmentID, "companyId": c.CompanyID, "name": c.Name})
	}
	c, err := load(*privateDir)
	if err != nil {
		return err
	}
	switch args[0] {
	case "protect":
		return protect(*privateDir, c, f.Args(), output)
	case "diagnose":
		return json.NewEncoder(output).Encode(map[string]any{"instance": c.Instance, "companyId": c.CompanyID, "outpostId": c.OutpostID, "environmentId": c.EnvironmentID, "versions": supported})
	case "connect", "daemon":
		return connect(*privateDir, c, output, args[0] == "daemon")
	default:
		return errors.New("unknown outpost command")
	}
}

func decode(r io.Reader, target any) error {
	data, err := io.ReadAll(io.LimitReader(r, 65537))
	if err != nil || len(data) > 65536 {
		return errors.New("invalid input")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(target) != nil {
		return errors.New("invalid input")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("invalid input")
	}
	return nil
}
func validateOrigin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("instance must be an origin without credentials, query or path")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return "", errors.New("instance requires HTTPS (HTTP is allowed only on loopback)")
	}
	return strings.TrimSuffix(value, "/"), nil
}
func validateHeaders(headers map[string]string) error {
	for name, value := range headers {
		if name != "CF-Access-Client-Id" && name != "CF-Access-Client-Secret" {
			return errors.New("only Cloudflare Access connection headers are supported")
		}
		if len(value) > 4096 || strings.ContainsAny(value, "\r\n") {
			return errors.New("invalid connection header")
		}
	}
	return nil
}
func request(origin, path string, body any, auth enrollment, target any) error {
	data, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, origin+path, bytes.NewReader(data))
	if err != nil {
		return errors.New("invalid request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", auth.OperatorAuthorization)
	for k, v := range auth.Headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return errors.New("Paperclip request failed")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("Paperclip request rejected (HTTP %d)", res.StatusCode)
	}
	if target != nil && json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(target) != nil {
		return errors.New("invalid Paperclip response")
	}
	return nil
}
func revoke(origin, company, id string, auth enrollment) {
	_ = request(origin, "/api/plugins/yelqo.outpost/api/outposts/"+url.PathEscape(id)+"/revoke", map[string]string{"companyId": company}, auth, nil)
}
func preparePrivate(dir, workspace, scratch string) error {
	if !filepath.IsAbs(dir) || !filepath.IsAbs(workspace) || !filepath.IsAbs(scratch) {
		return errors.New("private, workspace and scratch roots must be absolute")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return errors.New("cannot create private connection directory")
	}
	if _, err := os.Lstat(filepath.Join(dir, "connection.json")); !os.IsNotExist(err) {
		return errors.New("connection state already exists or cannot be inspected")
	}
	return validatePrivate(dir, workspace, scratch)
}
func validatePrivate(dir, workspace, scratch string) error {
	canonical, err := filepath.EvalSymlinks(dir)
	if err != nil || canonical != filepath.Clean(dir) {
		return errors.New("private directory must exist without symlink aliases")
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 || !owned(info) {
		return errors.New("private connection directory requires mode 0700")
	}
	for _, root := range []string{workspace, scratch} {
		r, err := filepath.EvalSymlinks(root)
		if err != nil || !filepath.IsAbs(root) {
			return errors.New("workspace and scratch roots must exist")
		}
		if containsPath(r, canonical) || containsPath(canonical, r) {
			return errors.New("private state must be outside workspace and scratch roots")
		}
	}
	return nil
}
func save(dir string, c Connection) error {
	file, err := os.OpenFile(filepath.Join(dir, "connection.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("connection state already exists or cannot be created")
	}
	defer file.Close()
	if json.NewEncoder(file).Encode(c) != nil || file.Sync() != nil {
		return errors.New("cannot persist connection state")
	}
	root, err := os.Open(dir)
	if err != nil {
		return errors.New("cannot persist private directory")
	}
	defer root.Close()
	if root.Sync() != nil {
		return errors.New("cannot persist private directory")
	}
	return nil
}
func load(dir string) (Connection, error) {
	var c Connection
	path := filepath.Join(dir, "connection.json")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || !owned(info) {
		return c, errors.New("connection state requires a regular mode 0600 file")
	}
	file, err := os.Open(path)
	if err != nil {
		return c, errors.New("cannot read connection state")
	}
	defer file.Close()
	if decode(file, &c) != nil {
		return c, errors.New("invalid connection state")
	}
	if err := validatePrivate(dir, c.WorkspaceRoot, c.ScratchRoot); err != nil {
		return c, err
	}
	if _, err := validateOrigin(c.Instance); err != nil {
		return c, err
	}
	if err := validateHeaders(c.Headers); err != nil {
		return c, err
	}
	if err := validateRuntimeRoots(dir, c); err != nil {
		return c, err
	}
	if err := validateRuntimeEnv(c.RuntimeEnv); err != nil {
		return c, err
	}
	return c, nil
}

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Provider variables are selected on the machine, never inferred from server
// settings or from the controller's credential-bearing environment.
func validateRuntimeEnv(names []string) error {
	for _, name := range names {
		if !envName.MatchString(name) || name == "TMPDIR" || name == "PI_APPROVAL_TRANSPORT" || name == "PI_APPROVAL_CALLBACK_URL" || strings.HasPrefix(name, "OUTPOST_") || strings.HasPrefix(name, "PAPERCLIP_") || strings.HasPrefix(name, "CF_ACCESS_") {
			return errors.New("runtime environment must select local variables outside reserved transport namespaces")
		}
	}
	return nil
}

// Writable runtime state is selected locally, never by an execution request.
func validateRuntimeRoots(privateDir string, c Connection) error {
	for _, root := range c.RuntimeRoots {
		canonical, err := filepath.EvalSymlinks(root)
		info, statErr := os.Stat(root)
		if err != nil || statErr != nil || !filepath.IsAbs(root) || canonical != filepath.Clean(root) || !info.IsDir() || !owned(info) {
			return errors.New("runtime roots must be existing canonical worker-owned directories")
		}
		for _, protected := range []string{privateDir, c.WorkspaceRoot, c.ScratchRoot} {
			if containsPath(root, protected) || containsPath(protected, root) {
				return errors.New("runtime state must be separate from private, workspace and scratch roots")
			}
		}
		if root == "/home" || root == "/tmp" || root == "/var/tmp" || (!containsPath("/home", root) && !containsPath("/tmp", root) && !containsPath("/var/tmp", root)) {
			return errors.New("runtime state must be under a worker home or temporary directory")
		}
	}
	return nil
}

func owned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid())
}

func containsPath(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))
}
