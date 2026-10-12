package outpost

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const serviceName = "paperclip-outpost.service"
const installRoot = "/opt/paperclip-outpost"
const unitPath = "/etc/systemd/system/" + serviceName

type installation struct {
	Version    string `json:"version"`
	Binary     string `json:"binary"`
	Worker     string `json:"worker"`
	PrivateDir string `json:"privateDir"`
}

var releaseVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$`)
var servicePath = regexp.MustCompile(`^/[A-Za-z0-9_./-]+$`)
var workerName = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

func manageService(args []string, output io.Writer) error {
	f := flag.NewFlagSet(args[0], flag.ContinueOnError)
	f.SetOutput(io.Discard)
	binary := f.String("binary", "", "selected standalone binary")
	version := f.String("version", "", "explicit selected release")
	worker := f.String("worker", "", "existing unprivileged worker account")
	privateDir := f.String("private-dir", "", "persisted protected connection directory")
	if f.Parse(args[1:]) != nil || f.NArg() != 0 {
		return errors.New("invalid service command arguments")
	}
	if os.Geteuid() != 0 {
		return errors.New("system service management requires root; run with sudo")
	}
	if args[0] == "service-status" {
		return serviceStatus(output)
	}
	selected := installation{Version: *version, Worker: *worker, PrivateDir: *privateDir}
	if !releaseVersion.MatchString(*version) || !filepath.IsAbs(*binary) {
		return errors.New("select an explicit release version and absolute standalone binary path")
	}
	selected.Binary = filepath.Join(installRoot, *version, "outpost")
	account, err := serviceAccount(selected)
	if err != nil {
		return err
	}
	// Never replace a live service or a previous release through initial setup.
	for _, path := range []string{unitPath, filepath.Join(installRoot, "installation.json")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			return errors.New("service installation already exists; inspect service-status before an operator-managed upgrade")
		}
	}
	if err := secureInstallDirectory(filepath.Dir(selected.Binary)); err != nil {
		return err
	}
	if err := secureInstallDirectory(filepath.Dir(unitPath)); err != nil {
		return err
	}
	source, err := os.Open(*binary)
	if err != nil {
		return errors.New("cannot read selected standalone binary")
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 128<<20 {
		return errors.New("selected binary must be a regular file smaller than 128 MiB")
	}
	destination, err := os.OpenFile(selected.Binary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0755)
	if err != nil {
		return errors.New("selected installed binary already exists or cannot be created")
	}
	installed := false
	unitWritten := false
	defer func() {
		if !installed {
			os.Remove(selected.Binary)
			if unitWritten {
				os.Remove(unitPath)
			}
		}
	}()
	_, copyErr := io.Copy(destination, source)
	modeErr := destination.Chmod(0755)
	syncErr := destination.Sync()
	closeErr := destination.Close()
	if copyErr != nil || modeErr != nil || syncErr != nil || closeErr != nil || syncPrivate(filepath.Dir(selected.Binary)) != nil {
		return errors.New("cannot persist selected standalone binary")
	}
	// Verify as the worker, never execute an operator-supplied binary as root.
	data, err := runAsWorker(selected.Binary, account, "version")
	var versions Versions
	if err != nil || json.Unmarshal(data, &versions) != nil || versions.Daemon != selected.Version {
		return errors.New("selected binary does not report the requested release version")
	}
	data, err = runAsWorker(selected.Binary, account, "diagnose", "--private-dir", selected.PrivateDir)
	var identity struct {
		OutpostID string `json:"outpostId"`
	}
	if err != nil || json.Unmarshal(data, &identity) != nil || identity.OutpostID == "" {
		return errors.New("worker must have valid protected registration state; run configure, register and check as the worker first")
	}
	unit := fmt.Sprintf(`[Unit]
Description=Paperclip Outpost
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=%s
Group=%s
WorkingDirectory=%s
Environment=HOME=%s
Environment=PATH=%s/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%s/service.env
ExecStart=%s daemon --private-dir %s
Restart=on-failure
RestartSec=5s
KillMode=control-group
TimeoutStopSec=30s
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`, selected.Worker, account.Gid, account.HomeDir, account.HomeDir, account.HomeDir,
		selected.PrivateDir, selected.Binary, selected.PrivateDir)
	if err := writeInstalledFile(unitPath, []byte(unit)); err != nil {
		return err
	}
	unitWritten = true
	// Retain a complete installation if systemd enable/start fails, so status
	// and a documented systemctl retry can diagnose and finish setup.
	metadata, _ := json.Marshal(selected)
	if err := writeInstalledFile(filepath.Join(installRoot, "installation.json"), metadata); err != nil {
		return err
	}
	installed = true
	if _, err := systemctl("daemon-reload"); err != nil {
		return err
	}
	if _, err := systemctl("enable", "--now", serviceName); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(selected)
}

func serviceAccount(selected installation) (*user.User, error) {
	if !workerName.MatchString(selected.Worker) || !servicePath.MatchString(selected.PrivateDir) || filepath.Clean(selected.PrivateDir) != selected.PrivateDir {
		return nil, errors.New("worker name and canonical private path must use service-safe letters, digits, dot, underscore, slash or hyphen")
	}
	account, err := user.Lookup(selected.Worker)
	if err != nil || account.Uid == "0" || account.Gid == "0" || !servicePath.MatchString(account.HomeDir) || filepath.Clean(account.HomeDir) != account.HomeDir {
		return nil, errors.New("service requires an existing unprivileged worker with an absolute service-safe home")
	}
	return account, nil
}

// Refuse aliases or worker-writable parents before installing privileged files.
func secureInstallDirectory(dir string) error {
	if dir != "/" {
		if err := secureInstallDirectory(filepath.Dir(dir)); err != nil {
			return err
		}
	}
	if err := os.Mkdir(dir, 0755); err == nil {
		// A restrictive operator umask must not prevent the worker from
		// traversing new installation directories to its selected executable.
		if os.Chmod(dir, 0755) != nil {
			return errors.New("cannot set durable installation directory permissions")
		}
	} else if !os.IsExist(err) {
		return errors.New("cannot create durable installation directory")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || !owned(info) || info.Mode().Perm()&0022 != 0 || info.Mode().Perm()&0001 == 0 {
		return errors.New("installation directories must be root-owned and traversable by the worker, without symlinks or group/other write access")
	}
	return nil
}

func writeInstalledFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return errors.New("installed service file already exists or cannot be created")
	}
	persisted := false
	defer func() {
		if !persisted {
			os.Remove(path)
		}
	}()
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil || syncPrivate(filepath.Dir(path)) != nil {
		return errors.New("cannot persist installed service file")
	}
	persisted = true
	return nil
}

func runAsWorker(binary string, account *user.User, args ...string) ([]byte, error) {
	uid, uidErr := strconv.ParseUint(account.Uid, 10, 32)
	gid, gidErr := strconv.ParseUint(account.Gid, 10, 32)
	if uidErr != nil || gidErr != nil {
		return nil, errors.New("cannot determine worker identity")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, args...)
	command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}}
	command.Env = []string{"HOME=" + account.HomeDir, "PATH=/usr/local/bin:/usr/bin:/bin"}
	return command.Output()
}

func systemctl(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/usr/bin/systemctl", args...)
	command.Env = []string{"PATH=/usr/bin:/bin", "SYSTEMD_PAGER=cat"}
	data, err := command.Output()
	if err != nil {
		return nil, errors.New("systemd command failed; inspect service-status and journalctl -u paperclip-outpost.service, then retry daemon-reload and enable --now")
	}
	return data, nil
}

func serviceStatus(output io.Writer) error {
	if err := secureInstallDirectory(installRoot); err != nil {
		return err
	}
	path := filepath.Join(installRoot, "installation.json")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || !owned(info) || info.Mode().Perm()&0022 != 0 {
		return errors.New("no protected service installation metadata; install a selected standalone release first")
	}
	data, err := os.ReadFile(path)
	var selected installation
	if err != nil || json.Unmarshal(data, &selected) != nil || !releaseVersion.MatchString(selected.Version) || selected.Binary != filepath.Join(installRoot, selected.Version, "outpost") {
		return errors.New("invalid service installation metadata")
	}
	account, err := serviceAccount(selected)
	if err != nil {
		return err
	}
	properties, err := systemctl("show", serviceName, "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus")
	if err != nil {
		return err
	}
	service := make(map[string]string)
	for _, line := range strings.Split(string(properties), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok && key != "" {
			service[strings.ToLower(key[:1])+key[1:]] = value
		}
	}
	data, err = runAsWorker(selected.Binary, account, "status", "--private-dir", selected.PrivateDir)
	var connection any
	if err != nil || json.Unmarshal(data, &connection) != nil {
		connection = map[string]string{"status": "unavailable", "diagnostic": "run status as the worker to inspect protected connection state"}
	}
	return json.NewEncoder(output).Encode(struct {
		installation
		Service    map[string]string `json:"service"`
		Connection any               `json:"connection"`
	}{selected, service, connection})
}
