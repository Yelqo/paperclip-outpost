package outpost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type executionFixture struct {
	supervisor *supervisor
	workspace  string
	identity   string
	root       string
}

func newExecutionFixture(t *testing.T) executionFixture {
	t.Helper()
	root := t.TempDir()
	for _, name := range []string{"private", "workspace", "scratch", "bin"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	// Only namespace setup is stubbed. Processes, directory locks and durable
	// execution records are real; the public workflow tests cover bubblewrap.
	launcher := "#!/bin/sh\nwhile [ $# -gt 0 ]; do\nif [ \"$1\" = -- ]; then shift; exec \"$@\"; fi\nshift\ndone\nexit 1\n"
	if err := os.WriteFile(filepath.Join(root, "bin", "bwrap"), []byte(launcher), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Join(root, "bin")+":"+os.Getenv("PATH"))
	c := Connection{WorkspaceRoot: filepath.Join(root, "workspace"), ScratchRoot: filepath.Join(root, "scratch")}
	s, err := newSupervisor(filepath.Join(root, "private"), c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		s.lock.Close()
		for _, owner := range s.owners {
			if owner.lock != nil {
				owner.lock.Close()
			}
		}
	})
	file, identity, err := s.workspace(c.WorkspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	return executionFixture{s, c.WorkspaceRoot, identity, root}
}

func (f executionFixture) operation(run, id, purpose string) operation {
	return operation{Type: "execute", RequestID: id, RunID: run, OperationID: id, Purpose: purpose,
		Cwd: f.workspace, WorkspaceID: f.identity, Command: "/bin/sh", Args: []string{"-c", "true"},
		Deadline: time.Now().Add(5 * time.Second).Format(time.RFC3339Nano)}
}

func handleResult(t *testing.T, s *supervisor, op operation) map[string]any {
	t.Helper()
	var result map[string]any
	s.handle(context.Background(), op, func(value any) error {
		message := value.(map[string]any)
		if message["type"] == "result" {
			result = message
		}
		return nil
	})
	if result == nil {
		t.Fatal("operation returned no result")
	}
	return result
}

func requireExecutionSuccess(t *testing.T, result map[string]any) {
	t.Helper()
	outcome, ok := result["result"].(processOutcome)
	if result["error"] != nil || !ok || outcome.Error != "" || outcome.ExitCode == nil || *outcome.ExitCode != 0 {
		t.Fatalf("operation did not succeed: %v", result)
	}
}

func (f executionFixture) startControl(t *testing.T) <-chan map[string]any {
	t.Helper()
	op := f.operation("A", "control", "control")
	started, finish := filepath.Join(f.root, "started"), filepath.Join(f.root, "finish")
	op.Args = []string{"-c", "touch \"$1\"; while ! test -e \"$2\"; do sleep .01; done", "control", started, finish}
	result := make(chan map[string]any, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.supervisor.handle(context.Background(), op, func(value any) error {
			message := value.(map[string]any)
			if message["type"] == "result" {
				result <- message
			}
			return nil
		})
	}()
	t.Cleanup(func() {
		os.WriteFile(finish, nil, 0600)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("control did not settle during cleanup")
		}
	})
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			return result
		}
		select {
		case message := <-result:
			t.Fatalf("control failed before its workspace effect: %v", message)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("control did not produce its workspace effect")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f executionFixture) finishControl(t *testing.T, result <-chan map[string]any) map[string]any {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.root, "finish"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case message := <-result:
		return message
	case <-time.After(5 * time.Second):
		t.Fatal("control did not terminate")
		return nil
	}
}

func TestControlOwnsWorkspaceUntilAllRunOperationsFinish(t *testing.T) {
	f := newExecutionFixture(t)
	control := f.startControl(t)
	inspect := operation{Type: "inspect", Cwd: f.workspace}
	if result := handleResult(t, f.supervisor, inspect)["result"].(map[string]string); result["ownerRunId"] != "A" {
		t.Fatalf("active control lost workspace ownership: %v", result)
	}
	for _, purpose := range []string{"agent_execution", "control"} {
		result := handleResult(t, f.supervisor, f.operation("B", "competing-"+purpose, purpose))
		if result["errorCode"] != "execution_unavailable" {
			t.Fatalf("conflicting %s was admitted: %v", purpose, result)
		}
	}
	independent := filepath.Join(f.workspace, "independent")
	if err := os.Mkdir(independent, 0700); err != nil {
		t.Fatal(err)
	}
	file, identity, err := f.supervisor.workspace(independent)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	parallel := f.operation("B", "parallel", "agent_execution")
	parallel.Cwd, parallel.WorkspaceID = independent, identity
	requireExecutionSuccess(t, handleResult(t, f.supervisor, parallel))
	for _, purpose := range []string{"agent_execution", "control"} {
		result := handleResult(t, f.supervisor, f.operation("A", "associated-"+purpose, purpose))
		requireExecutionSuccess(t, result)
	}
	if result := handleResult(t, f.supervisor, inspect)["result"].(map[string]string); result["ownerRunId"] != "A" {
		t.Fatalf("sibling completion released an active control: %v", result)
	}
	requireExecutionSuccess(t, f.finishControl(t, control))
	result := handleResult(t, f.supervisor, f.operation("B", "after-control", "agent_execution"))
	requireExecutionSuccess(t, result)
}

func TestControlLockExcludesAnotherDaemon(t *testing.T) {
	f := newExecutionFixture(t)
	control := f.startControl(t)
	private := filepath.Join(f.root, "other-private")
	if err := os.Mkdir(private, 0700); err != nil {
		t.Fatal(err)
	}
	other, err := newSupervisor(private, f.supervisor.connection)
	if err != nil {
		t.Fatal(err)
	}
	defer other.lock.Close()
	for _, purpose := range []string{"agent_execution", "control"} {
		result := handleResult(t, other, f.operation("B", "other-"+purpose, purpose))
		if result["errorCode"] != "execution_unavailable" {
			t.Fatalf("another daemon admitted a conflicting %s: %v", purpose, result)
		}
	}
	requireExecutionSuccess(t, f.finishControl(t, control))
	requireExecutionSuccess(t, handleResult(t, other, f.operation("B", "other-after-control", "agent_execution")))
}

func TestUncertainControlRetainsOwnershipAfterSiblingCompletionAndRestart(t *testing.T) {
	f := newExecutionFixture(t)
	control := f.startControl(t)
	hash := sha256.Sum256([]byte("control"))
	blockedWrite := filepath.Join(f.supervisor.dir, "operation-"+hex.EncodeToString(hash[:])+".json.tmp")
	if err := os.Mkdir(blockedWrite, 0700); err != nil {
		t.Fatal(err)
	}
	result := f.finishControl(t, control)
	if outcome := result["result"].(processOutcome); !outcome.OwnershipUncertain {
		t.Fatalf("terminal persistence failure was not reported as uncertain: %v", outcome)
	}
	requireExecutionSuccess(t, handleResult(t, f.supervisor, f.operation("A", "known-agent", "agent_execution")))
	if result := handleResult(t, f.supervisor, f.operation("B", "before-restart", "agent_execution")); result["errorCode"] != "execution_unavailable" {
		t.Fatalf("known agent completion freed an uncertain control: %v", result)
	}
	if err := os.Remove(blockedWrite); err != nil {
		t.Fatal(err)
	}
	for _, owner := range f.supervisor.owners {
		if owner.lock != nil {
			owner.lock.Close()
		}
	}
	f.supervisor.lock.Close()
	restarted, err := newSupervisor(f.supervisor.dir, f.supervisor.connection)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.lock.Close()
	if result := handleResult(t, restarted, f.operation("B", "after-restart", "agent_execution")); result["errorCode"] != "execution_unavailable" {
		t.Fatalf("restart freed an uncertain control: %v", result)
	}
}
