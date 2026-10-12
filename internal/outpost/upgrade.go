package outpost

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func serviceLifecycle(action, sourcePath, version string, force bool, timeout time.Duration, output io.Writer) error {
	if action == "service-drain" && force {
		return errors.New("service-drain does not support --force; use service-stop --force")
	}
	selected, err := readInstallation()
	if err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(installRoot, "management.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return errors.New("cannot open protected service management lock")
	}
	defer lock.Close()
	info, err := lock.Stat()
	if err != nil || !info.Mode().IsRegular() || !owned(info) || info.Mode().Perm() != 0600 || syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return errors.New("service management already in progress or its lock is unsafe; retry after the current operation")
	}
	// Reload after locking; another operator may have completed an upgrade.
	selected, err = readInstallation()
	if err != nil {
		return err
	}
	account, err := serviceAccount(selected)
	if err != nil {
		return err
	}
	var staged string
	next := selected
	if action == "service-upgrade" {
		if !releaseVersion.MatchString(version) || !filepath.IsAbs(sourcePath) {
			return errors.New("select an explicit release version and absolute standalone binary path")
		}
		next.Version, next.Binary = version, filepath.Join(installRoot, version, "outpost")
		staged, err = stageRelease(sourcePath, next, account)
		if err != nil {
			return err
		}
		defer os.Remove(staged)
	}
	request := "drain"
	if force {
		// Durable intent precedes systemd's signal to the entire process group;
		// a launcher can exit before the daemon handles its own signal.
		request = "stop-intent"
	}
	if _, err := runAsWorker(selected.Binary, account, request, "--private-dir", selected.PrivateDir); err != nil {
		return errors.New("cannot persist lifecycle request; inspect service-status before retrying")
	}
	if !force {
		if err := waitForDrain(selected, account, timeout); err != nil {
			return err
		}
	}
	if action == "service-drain" {
		return json.NewEncoder(output).Encode(map[string]string{"status": "drained"})
	}
	if err := stopService(selected, account); err != nil {
		return err
	}
	if action == "service-stop" {
		return json.NewEncoder(output).Encode(map[string]string{"status": "termination-confirmed"})
	}
	// No live process references the replacement. Keep every previous release
	// and all worker state; operator-selected reinstalls use an atomic rename.
	if err := os.Rename(staged, next.Binary); err != nil || syncPrivate(filepath.Dir(next.Binary)) != nil {
		return errors.New("cannot replace selected binary; service remains stopped and drained")
	}
	if err := replaceInstalledFile(unitPath, []byte(serviceUnit(next, account))); err != nil {
		return err
	}
	metadata, _ := json.Marshal(next)
	if err := replaceInstalledFile(filepath.Join(installRoot, "installation.json"), metadata); err != nil {
		return err
	}
	if _, err := systemctl("daemon-reload"); err != nil {
		return err
	}
	// A preflight proves compatibility before draining; recheck after stopping
	// in case the instance changed while active work was completing.
	if _, err := runAsWorker(next.Binary, account, "upgrade-check", "--private-dir", next.PrivateDir); err != nil {
		return errors.New("selected release no longer passes instance compatibility; service remains stopped and drained; install the matching plugin/host then retry service-upgrade")
	}
	if _, err := runAsWorker(next.Binary, account, "resume", "--private-dir", next.PrivateDir); err != nil {
		return errors.New("cannot resume selected release; run resume as the worker before starting the service")
	}
	if _, err := systemctl("start", serviceName); err != nil {
		_, _ = runAsWorker(next.Binary, account, "drain", "--private-dir", next.PrivateDir)
		return err
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := workerStatus(next, account)
		if err == nil && status.Status == "connected" && status.Lifecycle == "running" {
			return json.NewEncoder(output).Encode(next)
		}
		time.Sleep(200 * time.Millisecond)
	}
	_, _ = runAsWorker(next.Binary, account, "drain", "--private-dir", next.PrivateDir)
	return errors.New("selected release did not reconnect before timeout; admission is drained; inspect service-status and journal, then retry service-upgrade")
}

func stageRelease(sourcePath string, next installation, account *user.User) (string, error) {
	if err := secureInstallDirectory(filepath.Dir(next.Binary)); err != nil {
		return "", err
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return "", errors.New("cannot read selected standalone binary")
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 128<<20 {
		return "", errors.New("selected binary must be a regular file smaller than 128 MiB")
	}
	file, err := os.CreateTemp(filepath.Dir(next.Binary), ".selected-*")
	if err != nil {
		return "", errors.New("cannot stage selected release")
	}
	path := file.Name()
	valid := false
	defer func() {
		if !valid {
			os.Remove(path)
		}
	}()
	_, copyErr := io.Copy(file, source)
	modeErr := file.Chmod(0755)
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil || modeErr != nil || syncErr != nil || closeErr != nil {
		return "", errors.New("cannot persist staged release")
	}
	data, err := runAsWorker(path, account, "version")
	var versions Versions
	if err != nil || json.Unmarshal(data, &versions) != nil || versions.Daemon != next.Version {
		return "", errors.New("selected binary does not report the requested release version")
	}
	if _, err := runAsWorker(path, account, "upgrade-check", "--private-dir", next.PrivateDir); err != nil {
		return "", errors.New("selected release is incompatible or cannot reach the instance; check matching plugin/host versions, registration and access settings; installed service is unchanged")
	}
	valid = true
	return path, nil
}

type lifecycleStatus struct {
	Status    string `json:"status"`
	Lifecycle string `json:"lifecycle"`
}

func workerStatus(selected installation, account *user.User) (lifecycleStatus, error) {
	var status lifecycleStatus
	data, err := runAsWorker(selected.Binary, account, "status", "--private-dir", selected.PrivateDir)
	if err != nil || json.Unmarshal(data, &status) != nil {
		return status, errors.New("cannot read worker lifecycle status")
	}
	return status, nil
}

func waitForDrain(selected installation, account *user.User, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := workerStatus(selected, account)
		if err != nil {
			return err
		}
		if status.Status == "connected" && status.Lifecycle == "drained" {
			return nil
		}
		if status.Status == "stopped" {
			if _, err := runAsWorker(selected.Binary, account, "verify-stopped", "--private-dir", selected.PrivateDir); err != nil {
				return errors.New("stopped service has uncertain execution history; inspect history before upgrading")
			}
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return errors.New("drain timed out; active work keeps its original limits and admission remains drained; inspect service-status then retry, resume as the worker, or explicitly service-stop --force")
}

func stopService(selected installation, account *user.User) error {
	data, err := systemctl("show", serviceName, "--property=ControlGroup", "--value")
	if err != nil {
		return err
	}
	group := strings.TrimSpace(string(data))
	if _, err := systemctl("stop", serviceName); err != nil {
		return err
	}
	if group != "" {
		if !strings.HasPrefix(group, "/") || strings.Contains(group, "..") {
			return errors.New("invalid systemd process group evidence")
		}
		err := filepath.WalkDir(filepath.Join("/sys/fs/cgroup", group), func(path string, entry os.DirEntry, err error) error {
			if os.IsNotExist(err) {
				return nil
			}
			if err != nil {
				return err
			}
			if entry.Name() == "cgroup.procs" {
				data, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				if strings.TrimSpace(string(data)) != "" {
					return errors.New("service process group is still populated")
				}
			}
			return nil
		})
		if err != nil {
			return errors.New("service process-tree termination is unconfirmed; inspect systemd before replacement or restart")
		}
	}
	if _, err := runAsWorker(selected.Binary, account, "verify-stopped", "--private-dir", selected.PrivateDir); err != nil {
		return errors.New("process termination or durable interruption is unconfirmed; inspect Paperclip history before replacement or restart")
	}
	return nil
}

func replaceInstalledFile(path string, data []byte) error {
	if err := secureInstallDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || !owned(info) || info.Mode().Perm()&0022 != 0 {
		return errors.New("cannot replace unsafe installed service file")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".upgrade-*")
	if err != nil {
		return errors.New("cannot stage installed service file")
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(data)
	modeErr := file.Chmod(0644)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || modeErr != nil || syncErr != nil || closeErr != nil || os.Rename(file.Name(), path) != nil || syncPrivate(filepath.Dir(path)) != nil {
		return fmt.Errorf("cannot persist upgraded %s; service remains stopped; inspect installation metadata and systemd unit before retrying", filepath.Base(path))
	}
	return nil
}
