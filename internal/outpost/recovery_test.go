package outpost

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCrashBoundariesNeverRepeatLaunch(t *testing.T) {
	for _, stage := range []string{"before-intent", "after-intent", "before-output-header", "after-output-header", "after-launch", "before-terminal", "after-terminal", "after-ack"} {
		t.Run(stage, func(t *testing.T) {
			f := newExecutionFixture(t)
			closeTestSupervisor(f.supervisor)
			op := f.operation("run", "crash-operation", "agent_execution")
			marker := filepath.Join(f.workspace, "launches")
			op.Args = []string{"-c", "echo effect >> \"$1\"; echo launched; sleep .05", "effect", marker}
			data, err := json.Marshal(op)
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(os.Args[0], "-test.run=^TestCrashProcess$")
			cmd.Env = append(os.Environ(), "OUTPOST_CRASH_STAGE="+stage, "OUTPOST_CRASH_ROOT="+f.root, "OUTPOST_CRASH_OPERATION="+string(data))
			output, err := cmd.CombinedOutput()
			if err == nil || cmd.ProcessState.ExitCode() != 77 {
				t.Fatalf("fault was not injected: %v %s", err, output)
			}
			restarted, err := newSupervisor(f.supervisor.dir, f.supervisor.connection)
			// The namespace stub can briefly retain the inherited directory FD
			// after its supervisor dies; wait for this actual lock to disappear.
			until := time.Now().Add(2 * time.Second)
			for err != nil && time.Now().Before(until) {
				time.Sleep(10 * time.Millisecond)
				restarted, err = newSupervisor(f.supervisor.dir, f.supervisor.connection)
			}
			if err != nil {
				t.Fatal(err)
			}
			defer closeTestSupervisor(restarted)
			handleResult(t, restarted, op)
			launches, err := os.ReadFile(marker)
			if err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if string(launches) != "" && string(launches) != "effect\n" {
				t.Fatalf("delivered operation launched twice: %q", launches)
			}
			if (stage == "after-intent" || stage == "before-output-header" || stage == "after-output-header") && len(launches) != 0 {
				t.Fatalf("intent-only crash launched on restart: %q", launches)
			}
			if stage == "after-terminal" || stage == "after-ack" {
				if restarted.records[op.OperationID].Outcome == nil || len(launches) == 0 {
					t.Fatal("terminal history was not retained")
				}
			}
		})
	}
}

// Only the test subprocess installs fault injection. Production has no crash
// environment variables or operator-facing fault switches.
func TestCrashProcess(t *testing.T) {
	stage := os.Getenv("OUTPOST_CRASH_STAGE")
	if stage == "" {
		return
	}
	root := os.Getenv("OUTPOST_CRASH_ROOT")
	s, err := newSupervisor(filepath.Join(root, "private"), Connection{WorkspaceRoot: filepath.Join(root, "workspace"), ScratchRoot: filepath.Join(root, "scratch")})
	if err != nil {
		t.Fatal(err)
	}
	var op operation
	if err := json.Unmarshal([]byte(os.Getenv("OUTPOST_CRASH_OPERATION")), &op); err != nil {
		t.Fatal(err)
	}
	s.fault = func(boundary string) {
		if boundary == stage {
			os.Exit(77)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s.handle(ctx, op, func(value any) error { return nil })
	t.Fatal("crash boundary was not reached")
}

func TestLiveProcessAndMissingLaunchEvidenceRetainWorkspace(t *testing.T) {
	for _, evidence := range []string{"live", "absent"} {
		t.Run(evidence, func(t *testing.T) {
			f := newExecutionFixture(t)
			cmd := exec.Command("sleep", "30")
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
			record := executionRecord{RunID: "previous", OperationID: "previous", Purpose: "agent_execution", Workspace: f.identity, BootID: f.supervisor.bootID, Status: "uncertain"}
			if evidence == "live" {
				record.ProcessID = cmd.Process.Pid
				start, _, err := processIdentity(record.ProcessID)
				if err != nil {
					t.Fatal(err)
				}
				record.ProcessStart = start
			}
			if err := f.supervisor.persist(record, true); err != nil {
				t.Fatal(err)
			}
			closeTestSupervisor(f.supervisor)
			restarted, err := newSupervisor(f.supervisor.dir, f.supervisor.connection)
			if err != nil {
				t.Fatal(err)
			}
			defer closeTestSupervisor(restarted)
			if result := handleResult(t, restarted, f.operation("other", "conflict", "agent_execution")); result["errorCode"] != "execution_unavailable" {
				t.Fatalf("unverified termination freed workspace: %v", result)
			}
			cmd.Process.Kill()
			cmd.Wait()
			if _, err := restarted.recoveryReports(false); err != nil {
				t.Fatal(err)
			}
			if evidence == "live" {
				requireExecutionSuccess(t, handleResult(t, restarted, f.operation("other", "after-loss", "agent_execution")))
			} else if result := handleResult(t, restarted, f.operation("other", "still-uncertain", "agent_execution")); result["errorCode"] != "execution_unavailable" {
				t.Fatalf("missing launch evidence invented termination: %v", result)
			}
		})
	}
}

func TestRebootReportsInterruptionWithoutRepeatingLaunch(t *testing.T) {
	f := newExecutionFixture(t)
	marker := filepath.Join(f.workspace, "launches")
	op := f.operation("run", "operation", "agent_execution")
	op.Args = []string{"-c", "echo effect >> \"$1\"", "effect", marker}
	requireExecutionSuccess(t, handleResult(t, f.supervisor, op))
	record := f.supervisor.records[op.OperationID]
	record.Outcome = nil
	record.BootID = "previous-boot"
	if err := f.supervisor.persist(record, false); err != nil {
		t.Fatal(err)
	}
	closeTestSupervisor(f.supervisor)
	restarted, err := newSupervisor(f.supervisor.dir, f.supervisor.connection)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestSupervisor(restarted)
	outcome := restarted.records[op.OperationID].Outcome
	if outcome == nil || !outcome.Interrupted || outcome.OwnershipUncertain {
		t.Fatalf("reboot did not establish interruption: %v", outcome)
	}
	handleResult(t, restarted, op)
	data, err := os.ReadFile(marker)
	if err != nil || string(data) != "effect\n" {
		t.Fatalf("recovery repeated the launch: %q %v", data, err)
	}
	requireExecutionSuccess(t, handleResult(t, restarted, f.operation("next", "next", "agent_execution")))
}

func TestRebootReconciliationPreservesObservedProcessHistory(t *testing.T) {
	for _, test := range []struct {
		name          string
		localStart    string
		expectedStart string
		wantFence     bool
	}{
		{"missing process evidence", "", "observed-start", true},
		{"regressed process evidence", "older-start", "observed-start", true},
		{"retained process evidence", "observed-start", "observed-start", false},
		{"unobserved process evidence", "", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newExecutionFixture(t)
			op := f.operation("previous", "snapshot-operation", "agent_execution")
			local := executionRecord{RunID: op.RunID, OperationID: op.OperationID, Purpose: op.Purpose,
				Workspace: f.identity, Deadline: op.Deadline, BootID: "previous-boot", Status: "uncertain"}
			if test.localStart != "" {
				local.ProcessID, local.ProcessStart = 12345, test.localStart
			}
			if err := f.supervisor.persist(local, true); err != nil {
				t.Fatal(err)
			}
			// The restored journal can predate process evidence already witnessed
			// by Paperclip. Startup observes a reboot and synthesizes interruption.
			expected := local
			if test.expectedStart != "" {
				expected.ProcessID, expected.ProcessStart, expected.Status = 12345, test.expectedStart, "running"
			}
			closeTestSupervisor(f.supervisor)
			restarted, err := newSupervisor(f.supervisor.dir, f.supervisor.connection)
			if err != nil {
				t.Fatal(err)
			}
			defer closeTestSupervisor(restarted)
			record, err := restarted.reconcileExpected(expected)
			if err != nil {
				t.Fatal(err)
			}
			if record.HistoryMissing != test.wantFence {
				t.Errorf("reboot reconciliation lost the history comparison: %+v", record)
			}
			if !test.wantFence {
				if record.Status != "interrupted" || record.Outcome == nil || !record.Outcome.Interrupted {
					t.Fatalf("intact history did not establish interruption: %+v", record)
				}
				requireExecutionSuccess(t, handleResult(t, restarted, f.operation("next", "next", "agent_execution")))
				return
			}
			if record.Status != "uncertain" || record.Outcome != nil {
				t.Errorf("regressed history was reported as terminated: %+v", record)
			}
			for _, run := range []string{"previous", "next"} {
				if result := handleResult(t, restarted, f.operation(run, run+":control", "control")); result["errorCode"] != "execution_unavailable" {
					t.Errorf("regressed history allowed %s to launch: %v", run, result)
				}
			}
			closeTestSupervisor(restarted)
			fenced, err := newSupervisor(f.supervisor.dir, f.supervisor.connection)
			if err != nil {
				t.Fatal(err)
			}
			defer closeTestSupervisor(fenced)
			if result := handleResult(t, fenced, f.operation("next", "after-restart", "agent_execution")); result["errorCode"] != "execution_unavailable" {
				t.Errorf("restart lost the durable history fence: %v", result)
			}
		})
	}
}

func TestMissingHistoryFenceSurvivesRepeatedReconciliation(t *testing.T) {
	f := newExecutionFixture(t)
	op := f.operation("previous", "missing-operation", "agent_execution")
	expected := executionRecord{RunID: op.RunID, OperationID: op.OperationID, Purpose: op.Purpose, Workspace: f.identity, Deadline: op.Deadline, Status: "uncertain"}
	for i := 0; i < 2; i++ {
		record, err := f.supervisor.reconcileExpected(expected)
		if err != nil {
			t.Fatal(err)
		}
		if !record.HistoryMissing || record.Outcome != nil {
			t.Fatalf("missing history was not reported as uncertain: %v", record)
		}
		expected = record
	}
	if result := handleResult(t, f.supervisor, f.operation("other", "conflict", "agent_execution")); result["errorCode"] != "execution_unavailable" {
		t.Fatalf("missing history permitted conflicting work: %v", result)
	}
}

func TestMissingHistoryForMultipleRunsRetainsOneWorkspaceFence(t *testing.T) {
	f := newExecutionFixture(t)
	for _, run := range []string{"first", "second"} {
		op := f.operation(run, run, "agent_execution")
		expected := executionRecord{RunID: op.RunID, OperationID: op.OperationID, Purpose: op.Purpose, Workspace: f.identity, Deadline: op.Deadline, Status: "uncertain"}
		record, err := f.supervisor.reconcileExpected(expected)
		if err != nil || !record.HistoryMissing {
			t.Fatalf("missing history for %s was not reconciled: %v %v", run, record, err)
		}
	}
	for _, run := range []string{"first", "second", "new"} {
		if result := handleResult(t, f.supervisor, f.operation(run, run+":control", "control")); result["errorCode"] != "execution_unavailable" {
			t.Fatalf("history fence admitted %s: %v", run, result)
		}
	}
	closeTestSupervisor(f.supervisor)
	restarted, err := newSupervisor(f.supervisor.dir, f.supervisor.connection)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestSupervisor(restarted)
	if result := handleResult(t, restarted, f.operation("new", "after-restart", "agent_execution")); result["errorCode"] != "execution_unavailable" {
		t.Fatalf("restart lost the shared history fence: %v", result)
	}
}
