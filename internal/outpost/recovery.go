package outpost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// Reconciliation exchanges one record at a time to stay below the transport
// frame bound. New dispatch is disabled until both histories are compared.
func reconcileSession(ctx context.Context, ws *websocket.Conn, s *supervisor) error {
	exchange := func(value any) (struct {
		Type        string          `json:"type"`
		Record      executionRecord `json:"record"`
		OperationID string          `json:"operationId"`
	}, error) {
		var reply struct {
			Type        string          `json:"type"`
			Record      executionRecord `json:"record"`
			OperationID string          `json:"operationId"`
		}
		step, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := wsjson.Write(step, ws, value); err != nil {
			return reply, errDisconnected
		}
		if err := wsjson.Read(step, ws, &reply); err != nil {
			return reply, errDisconnected
		}
		return reply, nil
	}
	records, err := s.recoveryReports(true)
	if err != nil {
		return err
	}
	reply, err := exchange(map[string]string{"type": "recovery_begin"})
	if err != nil {
		return err
	}
	if reply.Type != "recovery_inventory" {
		return errRejected
	}
	page := make([][2]string, 0, 100)
	sendPage := func() error {
		ack, err := exchange(map[string]any{"type": "recovery_inventory", "records": page})
		if err != nil {
			return err
		}
		if ack.Type != "ack" {
			return errRejected
		}
		return nil
	}
	for _, record := range records {
		entry := [2]string{record.OperationID, recordDigest(record)}
		candidate := append(page, entry)
		data, _ := json.Marshal(map[string]any{"type": "recovery_inventory", "records": candidate})
		if len(candidate) > 100 || len(data) > 60000 {
			if len(page) == 0 {
				return errRejected
			}
			if err := sendPage(); err != nil {
				return err
			}
			page = [][2]string{entry}
		} else {
			page = candidate
		}
	}
	if len(page) > 0 {
		if err := sendPage(); err != nil {
			return err
		}
	}
	reply, err = exchange(map[string]string{"type": "recovery_inventory_complete"})
	if err != nil {
		return err
	}
	for reply.Type == "recovery_probe" {
		var record executionRecord
		var err error
		if reply.Record.OperationID != "" {
			record, err = s.reconcileExpected(reply.Record)
		} else {
			s.mu.Lock()
			var exists bool
			record, exists = s.records[reply.OperationID]
			s.mu.Unlock()
			if !exists {
				return errors.New("execution history disappeared during reconciliation")
			}
		}
		if err != nil {
			// Report uncertainty even if a missing/replaced directory prevents
			// reacquiring its lock. Dispatch remains disabled for this session.
			if record.OperationID != "" {
				_, _ = exchange(map[string]any{"type": "recovery_record", "record": record})
			}
			return err
		}
		reply, err = exchange(map[string]any{"type": "recovery_record", "record": record})
		if err != nil {
			return err
		}
	}
	if reply.Type != "recovery_upload" {
		return errRejected
	}
	records, err = s.recoveryReports(false)
	if err != nil {
		return err
	}
	for _, record := range records {
		reply, err = exchange(map[string]any{"type": "history", "record": record})
		if err != nil {
			return err
		}
		if reply.Type != "ack" {
			return errRejected
		}
	}
	reply, err = exchange(map[string]string{"type": "recovery_complete"})
	if err != nil {
		return err
	}
	if reply.Type != "recovery_ready" {
		return errRejected
	}
	return nil
}

func recordDigest(record executionRecord) string {
	var outcome any
	if record.Outcome != nil {
		r := record.Outcome
		outcome = []any{r.ExitCode, r.Signal, r.TimedOut, r.Error, r.OwnershipUncertain, r.Interrupted}
	}
	data, _ := json.Marshal([]any{record.RunID, record.OperationID, record.Purpose, record.Workspace, record.Deadline, record.BootID,
		record.ProcessID, record.ProcessStart, record.HistoryMissing, record.Refused, record.Status, outcome})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func recordStatus(record executionRecord) string {
	if record.Outcome == nil || record.Outcome.OwnershipUncertain {
		return "uncertain"
	}
	if record.Outcome.Interrupted {
		return "interrupted"
	}
	return "terminal"
}

func (s *supervisor) releaseOperation(record executionRecord) {
	owner := s.owners[record.Workspace]
	if owner == nil {
		return
	}
	delete(owner.operations, record.OperationID)
	if owner.agentOperation == record.OperationID {
		owner.agentOperation = ""
	}
	if len(owner.operations) == 0 {
		delete(s.owners, record.Workspace)
		if owner.lock != nil {
			owner.lock.Close()
		}
	}
}

// Missing local records and regressed terminal history are consumed tombstones,
// not evidence that a launch was never delivered. Never recreate them as work.
func (s *supervisor) reconcileExpected(expected executionRecord) (executionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	local, exists := s.records[expected.OperationID]
	if !exists && expected.Refused && expected.Outcome != nil && !expected.HistoryMissing {
		if err := s.persist(expected, true); err != nil {
			return executionRecord{}, errors.New("cannot persist before-launch receipt")
		}
		s.records[expected.OperationID] = expected
		return expected, nil
	}
	if exists && (local.RunID != expected.RunID || local.Purpose != expected.Purpose || local.Workspace != expected.Workspace || local.Deadline != expected.Deadline) {
		return executionRecord{}, errors.New("conflicting execution history identity")
	}
	// Startup may already have established interruption from a reboot. That
	// proves process loss, but cannot repair process evidence lost to rollback.
	if !exists || expected.HistoryMissing || (expected.Outcome != nil && !reflect.DeepEqual(expected.Outcome, local.Outcome)) ||
		(expected.ProcessStart != "" && local.ProcessStart != expected.ProcessStart) {
		local = expected
		local.Outcome = nil
		local.Status = "uncertain"
		local.HistoryMissing = true
		s.records[local.OperationID] = local
		owner := s.owners[local.Workspace]
		if owner == nil {
			owner = &workspaceOwnership{runID: local.RunID, operations: map[string]struct{}{}}
			s.owners[local.Workspace] = owner
		}
		// A rollback can lose several completed runs in the same directory.
		// Their tombstones share a fence that blocks even associated controls.
		owner.historyMissing = true
		owner.operations[local.OperationID] = struct{}{}
		if local.Purpose == "agent_execution" {
			owner.agentOperation = local.OperationID
		}
		if err := s.persist(local, !exists); err != nil {
			return local, errors.New("cannot persist missing history fence")
		}
		if err := s.restoreWorkspaceLocks(); err != nil {
			return local, err
		}
	}
	return local, nil
}

func (s *supervisor) recoveryReports(all bool) ([]executionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, record := range s.records {
		if record.Status == "uncertain" && record.Outcome == nil && s.terminated(record) {
			record.Outcome = interruptedOutcome()
			record.Status = "interrupted"
			if err := s.persist(record, false); err != nil {
				return nil, errors.New("cannot persist interruption")
			}
			s.records[id] = record
			s.releaseOperation(record)
		}
	}
	records := s.reports
	if all {
		records = s.records
	}
	result := make([]executionRecord, 0, len(records))
	for _, record := range records {
		result = append(result, record)
	}
	s.reports = map[string]executionRecord{}
	return result, nil
}

func interruptedOutcome() *processOutcome {
	return &processOutcome{Interrupted: true, Error: "execution interrupted; process loss verified, operation will not launch again"}
}

// PID alone is never evidence: boot identity and /proc start time distinguish
// reused PIDs. The recorded process is the protected namespace's PID 1.
func processIdentity(pid int) (start, state string, err error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", "", err
	}
	end := strings.LastIndex(string(data), ")")
	if end < 0 {
		return "", "", errors.New("invalid process evidence")
	}
	fields := strings.Fields(string(data)[end+1:])
	if len(fields) < 20 {
		return "", "", errors.New("invalid process evidence")
	}
	return fields[19], fields[0], nil
}

func (s *supervisor) terminated(record executionRecord) bool {
	if record.HistoryMissing || record.BootID == "" {
		return false
	}
	if record.BootID != s.bootID {
		return true
	}
	if record.ProcessID <= 0 || record.ProcessStart == "" {
		return false
	}
	start, state, err := processIdentity(record.ProcessID)
	return os.IsNotExist(err) || (err == nil && (start != record.ProcessStart || state == "Z" || state == "X"))
}
