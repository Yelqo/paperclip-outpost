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

type lifecycleState struct {
	Status    string `json:"status"`
	ForceStop bool   `json:"forceStop,omitempty"`
}

func readLifecycle(dir string) (lifecycleState, error) {
	var state lifecycleState
	path := filepath.Join(dir, "lifecycle.json")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return lifecycleState{Status: "running"}, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || !owned(info) {
		return state, errors.New("cannot read protected lifecycle state")
	}
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &state) != nil || (state.Status != "running" && state.Status != "draining") || (state.ForceStop && state.Status != "draining") {
		return state, errors.New("invalid lifecycle state; run drain or resume as the worker")
	}
	return state, nil
}

func setLifecycle(dir, state string, output io.Writer) error {
	return persistLifecycle(dir, lifecycleState{Status: state}, output)
}

func persistLifecycle(dir string, state lifecycleState, output io.Writer) error {
	file, err := os.CreateTemp(dir, ".lifecycle-*")
	if err != nil {
		return errors.New("cannot write protected lifecycle state")
	}
	defer os.Remove(file.Name())
	data, _ := json.Marshal(state)
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil || os.Rename(file.Name(), filepath.Join(dir, "lifecycle.json")) != nil || syncPrivate(dir) != nil {
		return errors.New("cannot persist lifecycle state")
	}
	return json.NewEncoder(output).Encode(state)
}

// Called under the admission mutex, including immediately before each launch.
func (s *supervisor) refreshLifecycle() (lifecycleState, error) {
	state, err := readLifecycle(s.dir)
	if err != nil {
		return state, err
	}
	if state.Status == "draining" && !s.draining {
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
	s.draining = state.Status == "draining"
	return state, nil
}

func (s *supervisor) lifecycle() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.refreshLifecycle()
	if err != nil {
		return "", err
	}
	return state.Status, nil
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
