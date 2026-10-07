package outpost

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maxOutputBytes = 1024 * 1024

// These refusals precede durable intent and are safe for Paperclip to defer.
type executionUnavailable struct{ message string }

func (e *executionUnavailable) Error() string { return e.message }

type operation struct {
	Type              string             `json:"type"`
	RequestID         string             `json:"requestId"`
	RunID             string             `json:"runId"`
	OperationID       string             `json:"operationId"`
	Purpose           string             `json:"purpose"`
	Cwd               string             `json:"cwd"`
	WorkspaceID       string             `json:"workspaceId"`
	Command           string             `json:"command"`
	Args              []string           `json:"args"`
	Env               map[string]string  `json:"env"`
	Stdin             string             `json:"stdin"`
	Deadline          string             `json:"deadline"`
	CallbackTransport *callbackTransport `json:"callbackTransport,omitempty"`
}

type callbackTransport struct {
	Instance  string `json:"instance"`
	CompanyID string `json:"companyId"`
	AgentID   string `json:"agentId"`
	TaskID    string `json:"taskId"`
	RunID     string `json:"runId"`
	QueueDir  string `json:"queueDir"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

type processOutcome struct {
	ExitCode           *int   `json:"exitCode"`
	Signal             string `json:"signal,omitempty"`
	TimedOut           bool   `json:"timedOut"`
	Error              string `json:"error,omitempty"`
	OwnershipUncertain bool   `json:"ownershipUncertain,omitempty"`
}

type executionRecord struct {
	RunID       string          `json:"runId"`
	OperationID string          `json:"operationId"`
	Purpose     string          `json:"purpose"`
	Workspace   string          `json:"workspace"`
	Deadline    string          `json:"deadline"`
	Outcome     *processOutcome `json:"outcome,omitempty"`
}

type workspaceOwnership struct {
	runID          string
	operations     map[string]struct{}
	agentOperation string
	lock           *os.File
}

// The supervisor survives transport sessions. A durable intent is a consumed
// operation even if a crash occurs before Start; uncertainty never authorizes it.
type supervisor struct {
	mu             sync.Mutex
	dir            string
	connection     Connection
	records        map[string]executionRecord
	owners         map[string]*workspaceOwnership
	activeAgents   int
	activeControls int
	lock           *os.File
}

func newSupervisor(dir string, c Connection) (*supervisor, error) {
	if os.Geteuid() == 0 {
		return nil, errors.New("daemon requires an unprivileged worker account")
	}
	lock, err := os.OpenFile(filepath.Join(dir, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, errors.New("cannot open daemon lock")
	}
	if syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		lock.Close()
		return nil, errors.New("daemon already running")
	}
	s := &supervisor{dir: dir, connection: c, records: map[string]executionRecord{}, owners: map[string]*workspaceOwnership{}, lock: lock}
	ready := false
	defer func() {
		if !ready {
			lock.Close()
			for _, owner := range s.owners {
				if owner.lock != nil {
					owner.lock.Close()
				}
			}
		}
	}()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "operation-") {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(dir, entry.Name()))
		var record executionRecord
		if readErr != nil || json.Unmarshal(data, &record) != nil || record.OperationID == "" || record.RunID == "" || record.Workspace == "" {
			return nil, errors.New("cannot reconcile execution history")
		}
		s.records[record.OperationID] = record
		if record.Outcome == nil {
			owner := s.owners[record.Workspace]
			if owner == nil {
				owner = &workspaceOwnership{runID: record.RunID, operations: map[string]struct{}{}}
				s.owners[record.Workspace] = owner
			}
			if owner.runID != record.RunID {
				return nil, errors.New("cannot reconcile conflicting workspace ownership")
			}
			owner.operations[record.OperationID] = struct{}{}
			if record.Purpose == "agent_execution" {
				owner.agentOperation = record.OperationID
			}
		}
	}
	if err := s.restoreWorkspaceLocks(); err != nil {
		return nil, err
	}
	ready = true
	return s, nil
}

// Restore directory exclusion before opening the transport. History stores the
// actual device/inode, so locating it under the worker root also handles renamed
// directories without changing the durable record format.
func (s *supervisor) restoreWorkspaceLocks() error {
	remaining := len(s.owners)
	if remaining == 0 {
		return nil
	}
	root, err := filepath.EvalSymlinks(s.connection.WorkspaceRoot)
	if err != nil {
		return errors.New("cannot restore uncertain workspace ownership")
	}
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			// Unrelated unreadable subtrees need not prevent recovery. Any
			// uncertain identity still missing after the scan fails startup.
			return nil
		}
		if !entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		stat := info.Sys().(*syscall.Stat_t)
		workspace := fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)
		owner := s.owners[workspace]
		if owner == nil || owner.lock != nil {
			return nil
		}
		file, actual, err := s.workspace(path)
		if err != nil {
			return err
		}
		if actual != workspace || syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
			file.Close()
			return errors.New("cannot lock uncertain workspace")
		}
		owner.lock = file
		remaining--
		if remaining == 0 {
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil || remaining != 0 {
		return errors.New("cannot restore uncertain workspace ownership")
	}
	return nil
}

func (s *supervisor) persist(record executionRecord, exclusive bool) error {
	hash := sha256.Sum256([]byte(record.OperationID))
	path := filepath.Join(s.dir, "operation-"+hex.EncodeToString(hash[:])+".json")
	flags := os.O_WRONLY | os.O_CREATE
	if exclusive {
		flags |= os.O_EXCL
	} else {
		path += ".tmp"
		flags |= os.O_TRUNC
	}
	file, err := os.OpenFile(path, flags, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(file).Encode(record)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if !exclusive {
		if err := os.Rename(path, strings.TrimSuffix(path, ".tmp")); err != nil {
			return err
		}
	}
	dir, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (s *supervisor) workspace(path string) (*os.File, string, error) {
	if !filepath.IsAbs(path) {
		return nil, "", errors.New("workspace must be an existing absolute directory")
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, "", errors.New("workspace must be an existing absolute directory")
	}
	root, err := filepath.EvalSymlinks(s.connection.WorkspaceRoot)
	if err != nil || !containsPath(root, canonical) {
		return nil, "", errors.New("workspace is outside the configured worker root")
	}
	file, err := os.Open(canonical)
	if err != nil {
		return nil, "", errors.New("workspace is unavailable")
	}
	info, err := file.Stat()
	if err != nil || !info.IsDir() {
		file.Close()
		return nil, "", errors.New("workspace must be an existing absolute directory")
	}
	stat := info.Sys().(*syscall.Stat_t)
	identity := fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)
	return file, identity, nil
}

func (s *supervisor) handle(ctx context.Context, op operation, send func(any) error) {
	admitted := false
	reply := func(value any, err error) {
		message := map[string]any{"type": "result", "requestId": op.RequestID, "runId": op.RunID, "operationId": op.OperationID, "result": value}
		if err != nil {
			message["error"] = err.Error()
			message["beforeLaunch"] = !admitted
			var unavailable *executionUnavailable
			if errors.As(err, &unavailable) {
				message["errorCode"] = "execution_unavailable"
			}
		}
		_ = send(message)
	}
	file, workspace, err := s.workspace(op.Cwd)
	if err != nil {
		reply(nil, err)
		return
	}
	retained := false
	defer func() {
		if !retained {
			file.Close()
		}
	}()
	if op.Type == "inspect" {
		s.mu.Lock()
		owner := s.owners[workspace]
		ownerRunID := ""
		if owner != nil {
			ownerRunID = owner.runID
		}
		if owner == nil || owner.lock == nil {
			if syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
				s.mu.Unlock()
				reply(nil, &executionUnavailable{"workspace is busy"})
				return
			}
			if owner != nil {
				owner.lock = file
				retained = true
			} else {
				_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
			}
		}
		s.mu.Unlock()
		reply(map[string]string{"cwd": file.Name(), "workspaceId": workspace, "ownerRunId": ownerRunID}, nil)
		return
	}
	if op.WorkspaceID != workspace {
		reply(nil, &executionUnavailable{"workspace changed before launch; inspect it again"})
		return
	}
	deadline, err := time.Parse(time.RFC3339Nano, op.Deadline)
	if err != nil || !deadline.After(time.Now()) || deadline.After(time.Now().Add(time.Hour)) || op.OperationID == "" || op.RunID == "" || (op.Purpose != "agent_execution" && op.Purpose != "control") || op.Command == "" {
		reply(nil, errors.New("explicit execution identity, purpose and bounded deadline are required"))
		return
	}
	var descriptorPath string
	if op.CallbackTransport != nil {
		transport := op.CallbackTransport
		expires, expiryErr := time.Parse(time.RFC3339Nano, transport.ExpiresAt)
		queueAllowed := false
		for _, root := range s.connection.RuntimeRoots {
			queueAllowed = queueAllowed || containsPath(root, transport.QueueDir)
		}
		if op.Purpose != "agent_execution" || transport.Instance != s.connection.Instance || transport.CompanyID != s.connection.CompanyID || transport.RunID != op.RunID || transport.AgentID == "" || transport.TaskID == "" || transport.Token == "" || expiryErr != nil || !expires.After(time.Now()) || expires.After(deadline.Add(time.Second)) || !queueAllowed {
			reply(nil, errors.New("callback transport scope does not match the registered instance and run"))
			return
		}
		file, createErr := os.CreateTemp(s.dir, "transport-")
		if createErr != nil {
			reply(nil, errors.New("cannot create private run transport"))
			return
		}
		descriptorPath = file.Name()
		defer os.Remove(descriptorPath)
		writeErr := json.NewEncoder(file).Encode(transport)
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			reply(nil, errors.New("cannot write private run transport"))
			return
		}
	}

	s.mu.Lock()
	if _, seen := s.records[op.OperationID]; seen {
		s.mu.Unlock()
		reply(nil, errors.New("operation was already admitted; it will not launch again"))
		return
	}
	owner := s.owners[workspace]
	if (owner != nil && owner.runID != op.RunID) ||
		(op.Purpose == "agent_execution" && ((owner != nil && owner.agentOperation != "") || s.activeAgents >= 16)) ||
		(op.Purpose == "control" && s.activeControls >= 16) {
		s.mu.Unlock()
		reply(nil, &executionUnavailable{"workspace is busy or its previous process outcome is uncertain"})
		return
	}
	// A directory flock also excludes a second registration/daemon with another
	// private directory, including a symlink or bind-mount alias of this workspace.
	if owner == nil || owner.lock == nil {
		if syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
			s.mu.Unlock()
			reply(nil, &executionUnavailable{"workspace is busy"})
			return
		}
		if owner == nil {
			owner = &workspaceOwnership{runID: op.RunID, operations: map[string]struct{}{}}
			s.owners[workspace] = owner
		}
		owner.lock = file
		retained = true
	}
	record := executionRecord{RunID: op.RunID, OperationID: op.OperationID, Purpose: op.Purpose, Workspace: workspace, Deadline: op.Deadline}

	admitted = true
	s.records[op.OperationID] = record
	owner.operations[op.OperationID] = struct{}{}
	if op.Purpose == "agent_execution" {
		owner.agentOperation = op.OperationID
	}
	if err := s.persist(record, true); err != nil {
		s.mu.Unlock()
		reply(nil, errors.New("cannot persist launch intent; execution refused"))
		return
	}
	if op.Purpose == "agent_execution" {
		s.activeAgents++
	} else {
		s.activeControls++
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if op.Purpose == "agent_execution" {
			s.activeAgents--
		} else {
			s.activeControls--
		}
		s.mu.Unlock()
	}()
	processCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	args := protectionArgs(s.dir, s.connection, op.Cwd)
	// Pin the actual directory at admission across path renames/replacements.
	args = append(args[:len(args)-1], "--bind", "/proc/self/fd/3", op.Cwd, "--")
	if descriptorPath != "" {
		args = append(args[:len(args)-1], "--ro-bind", descriptorPath, descriptorPath, "--")
	}
	cmd := exec.CommandContext(processCtx, "bwrap", append(args, append([]string{op.Command}, op.Args...)...)...)
	cmd.ExtraFiles = []*os.File{file}
	cmd.Env = workerEnv(s.connection)
	for name, value := range op.Env {
		if name == "PI_APPROVAL_TRANSPORT" {
			continue
		}
		if !strings.ContainsAny(name, "=\x00") && !strings.ContainsRune(value, 0) {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	if descriptorPath != "" {
		cmd.Env = append(cmd.Env, "PI_APPROVAL_TRANSPORT="+descriptorPath)
	}
	cmd.Stdin = strings.NewReader(op.Stdin)
	var outputMu sync.Mutex
	outputBytes := 0
	limited := false
	writer := func(stream string) io.Writer {
		return outputWriter(func(data []byte) (int, error) {
			outputMu.Lock()
			defer outputMu.Unlock()
			if outputBytes+len(data) > maxOutputBytes {
				limited = true
				cancel()
				return 0, errors.New("output limit exceeded")
			}
			outputBytes += len(data)
			for offset := 0; offset < len(data); offset += 2048 {
				end := offset + 2048
				if end > len(data) {
					end = len(data)
				}
				if err := send(map[string]any{"type": "output", "requestId": op.RequestID, "runId": op.RunID, "operationId": op.OperationID, "stream": stream, "data": base64.StdEncoding.EncodeToString(data[offset:end])}); err != nil {
					cancel()
					return 0, err
				}
			}
			return len(data), nil
		})
	}
	cmd.Stdout = writer("stdout")
	cmd.Stderr = writer("stderr")
	err = cmd.Run()
	outcome := processOutcome{TimedOut: processCtx.Err() == context.DeadlineExceeded}
	if cmd.ProcessState != nil {
		status := cmd.ProcessState.Sys().(syscall.WaitStatus)
		if status.Signaled() {
			outcome.Signal = status.Signal().String()
		} else {
			code := status.ExitStatus()
			outcome.ExitCode = &code
		}
	} else if err != nil {
		outcome.Error = "protected process could not start"
	}
	if limited {
		outcome.Error = "output limit exceeded"
	}
	s.mu.Lock()
	record.Outcome = &outcome
	if s.persist(record, false) == nil {
		s.records[op.OperationID] = record
		delete(owner.operations, op.OperationID)
		if op.Purpose == "agent_execution" {
			owner.agentOperation = ""
		}
		if len(owner.operations) == 0 {
			delete(s.owners, workspace)
			owner.lock.Close()
		}
	} else {
		outcome.Error = "process ended but its durable outcome is uncertain"
		outcome.OwnershipUncertain = true
	}
	s.mu.Unlock()
	reply(outcome, nil)
}

type outputWriter func([]byte) (int, error)

func (w outputWriter) Write(data []byte) (int, error) { return w(data) }
