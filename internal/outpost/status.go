package outpost

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type daemonStatus struct {
	Status       string    `json:"status"`
	UpdatedAt    time.Time `json:"updatedAt"`
	ProcessID    int       `json:"processId"`
	ProcessStart string    `json:"processStart"`
	BootID       string    `json:"bootId"`
	Lifecycle    string    `json:"lifecycle,omitempty"`
}

func writeDaemonStatus(dir, status string, lifecycle ...string) error {
	start, _, err := processIdentity(os.Getpid())
	boot, bootErr := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || bootErr != nil {
		return errors.New("cannot establish daemon status identity")
	}
	file, err := os.CreateTemp(dir, ".status-*")
	if err != nil {
		return errors.New("cannot write protected daemon status")
	}
	defer os.Remove(file.Name())
	state := ""
	if len(lifecycle) > 0 {
		state = lifecycle[0]
	}
	err = json.NewEncoder(file).Encode(daemonStatus{status, time.Now().UTC(), os.Getpid(), start, strings.TrimSpace(string(boot)), state})
	closeErr := file.Close()
	if err != nil || closeErr != nil || os.Rename(file.Name(), filepath.Join(dir, "daemon-status.json")) != nil {
		return errors.New("cannot update protected daemon status")
	}
	return nil
}

func connectionStatus(dir string, c Connection, output io.Writer) error {
	status := "stopped"
	var recorded daemonStatus
	path := filepath.Join(dir, "daemon-status.json")
	info, err := os.Lstat(path)
	if err == nil && info.Mode().IsRegular() && info.Mode().Perm() == 0600 && owned(info) {
		data, readErr := os.ReadFile(path)
		if readErr == nil && json.Unmarshal(data, &recorded) == nil && recorded.ProcessID > 0 {
			start, state, evidenceErr := processIdentity(recorded.ProcessID)
			boot, bootErr := os.ReadFile("/proc/sys/kernel/random/boot_id")
			if evidenceErr == nil && bootErr == nil && start == recorded.ProcessStart && state != "Z" && state != "X" && strings.TrimSpace(string(boot)) == recorded.BootID {
				switch recorded.Status {
				case "connecting", "connected", "reconnecting", "rejected", "stopped":
					status = recorded.Status
				}
			}
		}
	}
	state, err := readLifecycle(dir)
	if err != nil {
		return err
	}
	lifecycle := state.Status
	if lifecycle == "draining" && status == "connected" && recorded.Lifecycle == "drained" {
		if requestedAt := lifecycleRequestedAt(dir); !requestedAt.IsZero() && recorded.UpdatedAt.After(requestedAt) {
			lifecycle = "drained"
		}
	}
	return json.NewEncoder(output).Encode(map[string]any{
		"status": status, "updatedAt": recorded.UpdatedAt,
		"lifecycle": lifecycle,
		"instance":  c.Instance, "companyId": c.CompanyID, "outpostId": c.OutpostID,
		"environmentId": c.EnvironmentID, "versions": supported,
	})
}
