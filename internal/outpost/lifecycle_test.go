package outpost

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestForcedStopRecordsInterruptionWhenLauncherExitsBeforeCancellation(t *testing.T) {
	for _, forced := range []bool{false, true} {
		name := "ordinary-signal"
		if forced {
			name = "forced-stop"
		}
		t.Run(name, func(t *testing.T) {
			f := newExecutionFixture(t)
			// Supply real process identity while stubbing only namespace setup.
			launcher := "#!/bin/sh\nprintf '{\"child-pid\":%s}\\n' \"$$\" >&4\nexec 4>&-\nwhile [ $# -gt 0 ]; do\nif [ \"$1\" = -- ]; then shift; exec \"$@\"; fi\nshift\ndone\nexit 1\n"
			if err := os.WriteFile(filepath.Join(f.root, "bin", "bwrap"), []byte(launcher), 0700); err != nil {
				t.Fatal(err)
			}
			completed := f.operation("previous", "completed", "agent_execution")
			requireExecutionSuccess(t, handleResult(t, f.supervisor, completed))
			op := f.operation("run", "stopped", "agent_execution")
			marker := filepath.Join(f.workspace, "launches")
			op.Args = []string{"-c", "echo once >> \"$1\"; exec sleep 30", "stop", marker}
			op.Deadline = time.Now().Add(time.Minute).Format(time.RFC3339Nano)
			result := make(chan map[string]any, 1)
			done := make(chan struct{})
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(func() {
				cancel()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Error("operation did not settle during cleanup")
				}
			})
			go func() {
				defer close(done)
				f.supervisor.handle(ctx, op, func(value any) error {
					message := value.(map[string]any)
					if message["type"] == "result" {
						result <- message
					}
					return nil
				})
			}()
			var pid int
			until := time.Now().Add(3 * time.Second)
			for time.Now().Before(until) {
				f.supervisor.mu.Lock()
				pid = f.supervisor.records[op.OperationID].ProcessID
				f.supervisor.mu.Unlock()
				if _, err := os.Stat(marker); pid > 0 && err == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
			if pid == 0 {
				t.Fatal("launcher did not report its process identity")
			}
			if _, err := os.Stat(marker); err != nil {
				t.Fatal("operation did not produce its launch effect")
			}
			if forced {
				c := f.supervisor.connection
				c.Instance = "http://127.0.0.1:12345"
				if err := persist(f.supervisor.dir, c, false); err != nil {
					t.Fatal(err)
				}
				if err := Run([]string{"stop-intent", "--private-dir", f.supervisor.dir}, nil, io.Discard); err != nil {
					t.Fatal(err)
				}
			}
			// Systemd's signal wins. The daemon context stays live until Wait and
			// outcome persistence finish, so CommandContext never kills the child.
			if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			select {
			case message := <-result:
				outcome := message["result"].(processOutcome)
				if outcome.Interrupted != forced || outcome.OwnershipUncertain || outcome.Cancelled {
					t.Fatalf("forced=%v: wrong outcome after external termination: %+v", forced, outcome)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("externally terminated operation did not settle")
			}
			cancel()
			<-done
			closeTestSupervisor(f.supervisor)
			restarted, err := newSupervisor(f.supervisor.dir, f.supervisor.connection)
			if err != nil {
				t.Fatal(err)
			}
			defer closeTestSupervisor(restarted)
			if restarted.records[op.OperationID].Outcome.Interrupted != forced {
				t.Fatal("restart lost interruption history")
			}
			if restarted.records[completed.OperationID].Outcome.Interrupted {
				t.Fatal("forced stop changed previously completed history")
			}
			handleResult(t, restarted, op)
			launches, err := os.ReadFile(marker)
			if err != nil || string(launches) != "once\n" {
				t.Fatalf("stopped operation replayed after restart: %q, %v", launches, err)
			}
		})
	}
}

func TestForcedStopFencesAssociatedControlsUntilResume(t *testing.T) {
	f := newExecutionFixture(t)
	requireExecutionSuccess(t, handleResult(t, f.supervisor, f.operation("run", "agent", "agent_execution")))
	if err := setLifecycle(f.supervisor.dir, "draining", io.Discard); err != nil {
		t.Fatal(err)
	}
	requireExecutionSuccess(t, handleResult(t, f.supervisor, f.operation("run", "drain-control", "control")))
	if err := persistLifecycle(f.supervisor.dir, lifecycleState{Status: "draining", ForceStop: true}, io.Discard); err != nil {
		t.Fatal(err)
	}
	op := f.operation("run", "stop-control", "control")
	if result := handleResult(t, f.supervisor, op); result["errorCode"] != "execution_unavailable" || result["beforeLaunch"] != true {
		t.Fatalf("forced stop admitted associated control: %v", result)
	}
	if err := setLifecycle(f.supervisor.dir, "running", io.Discard); err != nil {
		t.Fatal(err)
	}
	requireExecutionSuccess(t, handleResult(t, f.supervisor, op))
}
