package outpost

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"
)

func lifecycleRequestedAt(dir string) time.Time {
	if info, err := os.Stat(filepath.Join(dir, "lifecycle.json")); err == nil {
		return info.ModTime()
	}
	return time.Time{}
}

func readLifecycle(dir string) (string, error) {
	path := filepath.Join(dir, "lifecycle.json")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return "running", nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || !owned(info) {
		return "", errors.New("cannot read protected lifecycle state")
	}
	data, err := os.ReadFile(path)
	var state struct {
		Status string `json:"status"`
	}
	if err != nil || json.Unmarshal(data, &state) != nil || (state.Status != "running" && state.Status != "draining") {
		return "", errors.New("invalid lifecycle state; run drain or resume as the worker")
	}
	return state.Status, nil
}

func setLifecycle(dir, state string, output io.Writer) error {
	file, err := os.CreateTemp(dir, ".lifecycle-*")
	if err != nil {
		return errors.New("cannot write protected lifecycle state")
	}
	defer os.Remove(file.Name())
	data, _ := json.Marshal(map[string]string{"status": state})
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil || os.Rename(file.Name(), filepath.Join(dir, "lifecycle.json")) != nil || syncPrivate(dir) != nil {
		return errors.New("cannot persist lifecycle state")
	}
	return json.NewEncoder(output).Encode(map[string]string{"status": state})
}

// Called under the admission mutex, including immediately before each launch.
func (s *supervisor) refreshLifecycle() error {
	state, err := readLifecycle(s.dir)
	if err != nil {
		return err
	}
	if state == "draining" && !s.draining {
		s.drainRuns = map[string]bool{}
		// Paperclip's lease spans gaps between operations. Its driver permits
		// controls only through a live run lease, so retain previously admitted
		// run identities even when their latest local operation has completed.
		for _, record := range s.records {
			if !record.Refused && !record.HistoryMissing {
				s.drainRuns[record.RunID] = true
			}
		}
	}
	s.draining = state == "draining"
	return nil
}

func (s *supervisor) lifecycle() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refreshLifecycle(); err != nil {
		return "", err
	}
	if s.draining {
		return "draining", nil
	}
	return "running", nil
}

func (s *supervisor) drained() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.draining || s.activeAgents != 0 || s.activeControls != 0 {
		return false
	}
	for _, record := range s.records {
		if record.Outcome == nil || record.Outcome.OwnershipUncertain {
			return false
		}
	}
	return s.outputs.retention()["operations"].(int) == 0
}
