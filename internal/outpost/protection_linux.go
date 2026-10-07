package outpost

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

// This profile is a prerequisite for launching a same-UID agent runtime. File
// modes prevent accidental disclosure; the mount and PID namespaces isolate it.
func protect(privateDir string, c Connection, command []string, output io.Writer) error {
	if len(command) == 0 {
		return errors.New("protect requires a command after --")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	args := protectionArgs(privateDir, c, c.WorkspaceRoot)
	cmd := exec.CommandContext(ctx, "bwrap", append(args, command...)...)
	cmd.Env = workerEnv(c)
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Run(); err != nil {
		return errors.New("protected runtime failed (Linux bubblewrap and user namespaces are required)")
	}
	return nil
}

func protectionArgs(privateDir string, c Connection, cwd string) []string {
	return []string{"--die-with-parent", "--new-session", "--unshare-pid", "--cap-drop", "ALL",
		"--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/sys",
		"--tmpfs", privateDir, "--bind", c.WorkspaceRoot, c.WorkspaceRoot,
		"--bind", c.ScratchRoot, c.ScratchRoot, "--chdir", cwd, "--"}
}

func workerEnv(c Connection) []string {
	var env []string
	for _, name := range []string{"PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM"} {
		if value, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+value)
		}
	}
	return append(env, "TMPDIR="+c.ScratchRoot)
}
