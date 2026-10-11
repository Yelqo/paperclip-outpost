package outpost

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOutputSurvivesUnavailableDelivery(t *testing.T) {
	f := newExecutionFixture(t)
	op := f.operation("output-run", "output-operation", "agent_execution")
	op.Args = []string{"-c", "cd \"$1\"; echo launch >> launches; printf first; sleep .1; printf second; echo completed > completed", "output", f.workspace}
	f.supervisor.handle(context.Background(), op, func(any) error { return errors.New("connection lost") })
	if _, err := os.Stat(filepath.Join(f.workspace, "completed")); err != nil {
		t.Fatalf("delivery failure stopped bounded execution: %v", err)
	}
	// Recovery is delivery of retained data, never another execute request.
	var output strings.Builder
	var outcome processOutcome
	if err := f.supervisor.deliverOutputs(func(value any) error {
		frame := value.(map[string]any)
		if frame["type"] == "output" {
			data, err := base64.StdEncoding.DecodeString(frame["data"].(string))
			if err != nil {
				t.Fatal(err)
			}
			output.Write(data)
		} else if frame["type"] == "result" {
			outcome = frame["result"].(processOutcome)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if output.String() != "firstsecond" || outcome.ExitCode == nil || *outcome.ExitCode != 0 {
		t.Fatalf("retained output/result was not recovered: %q %+v", output.String(), outcome)
	}
	launches, _ := os.ReadFile(filepath.Join(f.workspace, "launches"))
	if string(launches) != "launch\n" {
		t.Fatalf("recovery relaunched: %q", launches)
	}
}

func TestOutputLimitWithWithheldAcknowledgements(t *testing.T) {
	f := newExecutionFixture(t, 4096, 8192)
	op := f.operation("limited-run", "limited-operation", "agent_execution")
	// An immediate shell builtin can race the asynchronous namespace kill after
	// the output pipe closes. A delayed effect proves that execution is stopped.
	op.Args = []string{"-c", "cd \"$1\"; echo launch >> launches; head -c 65536 /dev/zero; sleep 1; echo forbidden > forbidden", "output", f.workspace}
	f.supervisor.handle(context.Background(), op, func(any) error { return errors.New("acknowledgement withheld") })
	if _, err := os.Stat(filepath.Join(f.workspace, "forbidden")); !os.IsNotExist(err) {
		t.Fatalf("exhausted process continued: %v", err)
	}
	var diskBytes int64
	if err := filepath.WalkDir(filepath.Join(f.root, "private", "output"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			diskBytes += info.Size()
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if diskBytes > 4096 {
		t.Fatalf("unacknowledged output exceeded bound: %d", diskBytes)
	}
	var outcome processOutcome
	if err := f.supervisor.deliverOutputs(func(value any) error {
		frame := value.(map[string]any)
		if frame["type"] == "result" {
			outcome = frame["result"].(processOutcome)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if outcome.Error != "output limit exceeded" {
		t.Fatalf("exhaustion did not report an explicit failure: %+v", outcome)
	}
	entries, err := os.ReadDir(filepath.Join(f.root, "private", "output"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("acknowledged data was not reclaimed: %v %v", entries, err)
	}
	// Consumption and terminal failure remain after output reclamation.
	result := handleResult(t, f.supervisor, op)
	if !strings.Contains(result["error"].(string), "already admitted") {
		t.Fatalf("exhaustion allowed replay: %v", result)
	}
}

func TestRetainedOutputSurvivesDaemonRestartAndLostAck(t *testing.T) {
	f := newExecutionFixture(t)
	op := f.operation("recovered-run", "recovered-output", "agent_execution")
	op.Args = []string{"-c", "printf stdout; sleep .05; printf stderr >&2"}
	f.supervisor.handle(context.Background(), op, func(any) error { return errors.New("lost acknowledgement") })
	closeTestSupervisor(f.supervisor)
	restarted, err := newSupervisor(filepath.Join(f.root, "private"), f.supervisor.connection)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeTestSupervisor(restarted) })
	var frames []string
	var result processOutcome
	if err := restarted.deliverOutputs(func(value any) error {
		frame := value.(map[string]any)
		if frame["type"] == "output" {
			data, _ := base64.StdEncoding.DecodeString(frame["data"].(string))
			frames = append(frames, frame["stream"].(string)+":"+string(data))
		} else {
			result = frame["result"].(processOutcome)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(frames, ",") != "stdout:stdout,stderr:stderr" || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("restart lost ordered output/result: %v %+v", frames, result)
	}
}

func TestDaemonWideOutputCapacityIsReclaimedAfterAck(t *testing.T) {
	f := newExecutionFixture(t, 4096, 4096)
	for i, id := range []string{"first", "second"} {
		op := f.operation(id, id, "agent_execution")
		op.Args = []string{"-c", "head -c 2048 /dev/zero"}
		f.supervisor.handle(context.Background(), op, func(any) error { return errors.New("offline") })
		if i == 0 {
			continue
		}
		var second processOutcome
		if err := f.supervisor.deliverOutputs(func(value any) error {
			frame := value.(map[string]any)
			if frame["operationId"] == "second" && frame["type"] == "result" {
				second = frame["result"].(processOutcome)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if second.Error != "output limit exceeded" {
			t.Fatalf("daemon-wide exhaustion was not reported: %+v", second)
		}
	}
	op := f.operation("third", "third", "agent_execution")
	op.Deadline = time.Now().Add(time.Second).Format(time.RFC3339Nano)
	op.Args = []string{"-c", "head -c 2048 /dev/zero"}
	requireExecutionSuccess(t, handleResult(t, f.supervisor, op))
}

func TestAcknowledgedOutputIsNotReplayedAfterRestart(t *testing.T) {
	f := newExecutionFixture(t)
	op := f.operation("cursor-run", "cursor-output", "agent_execution")
	op.Args = []string{"-c", "printf acknowledged; sleep .05; printf retained"}
	var deliveries int
	f.supervisor.handle(context.Background(), op, func(value any) error {
		if value.(map[string]any)["type"] == "output" {
			deliveries++
			if deliveries == 1 {
				return nil
			}
		}
		return errors.New("ack withheld")
	})
	closeTestSupervisor(f.supervisor)
	restarted, err := newSupervisor(filepath.Join(f.root, "private"), f.supervisor.connection)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeTestSupervisor(restarted) })
	var output strings.Builder
	if err := restarted.deliverOutputs(func(value any) error {
		frame := value.(map[string]any)
		if frame["type"] == "output" {
			data, _ := base64.StdEncoding.DecodeString(frame["data"].(string))
			output.Write(data)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if output.String() != "retained" {
		t.Fatalf("restart ignored durable acknowledgement cursor: %q", output.String())
	}
}

func TestSpoolReservationFailureSurvivesLostDelivery(t *testing.T) {
	for _, restart := range []bool{false, true} {
		name := "reconnect"
		if restart {
			name = "daemon-restart"
		}
		t.Run(name, func(t *testing.T) {
			f := newExecutionFixture(t, 4096, 4096)
			retained := f.operation("retained-run", "retained-output", "control")
			store := f.supervisor.outputs
			if err := store.create(retained, func(string) {}); err != nil {
				t.Fatal(err)
			}
			// Two frames fill the actual byte quota, leaving no room for another
			// identity header. Keep their acknowledgements withheld throughout.
			remaining := 4096 - store.retention()["bytes"].(int64)
			if err := store.append(retained.OperationID, "stdout", make([]byte, remaining-10)); err != nil {
				t.Fatal(err)
			}
			if store.retention()["bytes"] != int64(4096) {
				t.Fatal("fixture did not fill output capacity")
			}
			op := f.operation("refused-run", "refused-operation", "agent_execution")
			op.RequestID = "original-request"
			op.Args = []string{"-c", "touch \"$1\"", "output", filepath.Join(f.workspace, "forbidden")}
			lost := errors.New("acknowledgement withheld")
			f.supervisor.handle(context.Background(), op, func(any) error { return lost })
			if _, err := os.Stat(filepath.Join(f.workspace, "forbidden")); !os.IsNotExist(err) {
				t.Fatalf("reservation failure launched the process: %v", err)
			}
			s := f.supervisor
			t.Cleanup(func() { closeTestSupervisor(s) })
			restartSupervisor := func() {
				closeTestSupervisor(s)
				restarted, err := newSupervisor(filepath.Join(f.root, "private"), f.supervisor.connection)
				if err != nil {
					t.Fatal(err)
				}
				s = restarted
			}
			if restart {
				restartSupervisor()
			}
			var results int
			send := func(value any) error {
				frame := value.(map[string]any)
				if frame["operationId"] == op.OperationID {
					outcome, ok := frame["result"].(processOutcome)
					if frame["type"] != "result" || frame["requestId"] != op.RequestID || frame["runId"] != op.RunID || !ok || outcome.Error != "output limit exceeded" || outcome.OwnershipUncertain {
						t.Fatalf("lost terminal identity or failure: %v", frame)
					}
					results++
				}
				return lost
			}
			if err := s.deliverOutputs(send); !errors.Is(err, lost) {
				t.Fatalf("unexpected delivery error: %v", err)
			}
			if results != 1 {
				t.Fatalf("reservation failure was not redelivered while output remained full: %d results", results)
			}
			// Losing that acknowledgement must also survive another restart.
			restartSupervisor()
			if err := s.deliverOutputs(func(value any) error {
				frame := value.(map[string]any)
				if frame["operationId"] == op.OperationID {
					_ = send(value)
					return nil
				}
				return lost
			}); !errors.Is(err, lost) {
				t.Fatalf("unexpected delivery error: %v", err)
			}
			if results != 2 {
				t.Fatalf("lost acknowledgement discarded the terminal result: %d results", results)
			}
			restartSupervisor()
			_ = s.deliverOutputs(send)
			if results != 2 {
				t.Fatal("acknowledged terminal result was replayed after restart")
			}
			if s.records[op.OperationID].Outcome.Error != "output limit exceeded" {
				t.Fatal("acknowledgement removed terminal history")
			}
			result := handleResult(t, s, op)
			if !strings.Contains(result["error"].(string), "already admitted") {
				t.Fatalf("reservation failure allowed replay: %v", result)
			}
		})
	}
}
