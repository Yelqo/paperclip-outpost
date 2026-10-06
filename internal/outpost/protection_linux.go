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
	args := []string{"--die-with-parent", "--new-session", "--unshare-pid",
		"--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/sys",
		"--tmpfs", privateDir, "--bind", c.WorkspaceRoot, c.WorkspaceRoot,
		"--bind", c.ScratchRoot, c.ScratchRoot, "--chdir", c.WorkspaceRoot, "--"}
	cmd := exec.CommandContext(ctx, "bwrap", append(args, command...)...)
	for _, name := range []string{"PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM"} {
		if value, ok := os.LookupEnv(name); ok {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "TMPDIR="+c.ScratchRoot)
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Run(); err != nil {
		return errors.New("protected runtime failed (Linux bubblewrap and user namespaces are required)")
	}
	return nil
}
