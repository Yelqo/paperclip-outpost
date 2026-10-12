package outpost

import (
	"errors"
	"os"
)

// Requests consume no launch authority. The original supervisor performs the
// kill and records its result before releasing workspace ownership.
func (s *supervisor) requestCancellation(runID, operationID string) (executionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, exists := s.records[operationID]
	if !exists || record.RunID != runID {
		return executionRecord{}, errors.New("unknown cancellation identity")
	}
	if record.Outcome != nil && !record.Outcome.OwnershipUncertain {
		return record, nil
	}
	record.CancelRequested = true
	if !s.records[operationID].CancelRequested {
		if err := s.persist(record, false); err != nil {
			return record, errors.New("cannot persist cancellation request")
		}
	}
	s.records[operationID] = record
	if cancel := s.cancels[operationID]; cancel != nil {
		cancel()
	} else if !record.HistoryMissing && record.BootID == s.bootID && record.ProcessID > 0 && record.ProcessStart != "" {
		// FindProcess owns a Linux pidfd. Check identity after opening it, then
		// signal that handle so PID reuse cannot redirect a recovered stop.
		process, err := os.FindProcess(record.ProcessID)
		if err == nil {
			defer process.Release()
			_ = process.WithHandle(func(_ uintptr) {
				start, state, evidenceErr := processIdentity(record.ProcessID)
				if evidenceErr == nil && start == record.ProcessStart && state != "Z" && state != "X" {
					_ = process.Kill()
				}
			})
		}
	}
	return record, nil
}
