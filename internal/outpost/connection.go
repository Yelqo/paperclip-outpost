package outpost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

var errRejected = errors.New("outpost connection rejected: verify registration, revocation and supported versions")
var errDisconnected = errors.New("outpost connection unavailable")

func connect(c Connection, output io.Writer, daemon bool) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	backoff := time.Second
	for {
		err := session(ctx, c, output, daemon)
		if ctx.Err() != nil {
			return nil
		}
		if !daemon || errors.Is(err, errRejected) {
			return err
		}
		// Neither request errors nor remote payloads cross the diagnostic boundary.
		if _, writeErr := io.WriteString(output, "outpost disconnected; retrying\n"); writeErr != nil {
			return errors.New("cannot write daemon status")
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func session(ctx context.Context, c Connection, output io.Writer, daemon bool) error {
	u, _ := url.Parse(c.Instance)
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/api/plugins/yelqo.outpost/ws/transport"
	u.RawQuery = url.Values{"companyId": {c.CompanyID}, "outpostId": {c.OutpostID}}.Encode()
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+c.Credential)
	versionJSON, _ := json.Marshal(supported)
	headers.Set("X-Outpost-Versions", string(versionJSON))
	for k, v := range c.Headers {
		headers.Set(k, v)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	ws, response, err := websocket.Dial(dialCtx, u.String(), &websocket.DialOptions{HTTPHeader: headers, HTTPClient: client, CompressionMode: websocket.CompressionDisabled})
	cancel()
	if err != nil {
		if response != nil && response.StatusCode >= 400 && response.StatusCode < 500 {
			return errRejected
		}
		return errDisconnected
	}
	defer ws.CloseNow()
	ws.SetReadLimit(16 * 1024)
	var ready struct {
		Type      string   `json:"type"`
		OutpostID string   `json:"outpostId"`
		CompanyID string   `json:"companyId"`
		Versions  Versions `json:"versions"`
	}
	readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = wsjson.Read(readCtx, ws, &ready)
	cancel()
	if err != nil {
		return errDisconnected
	}
	if ready.Type != "ready" || ready.OutpostID != c.OutpostID || ready.CompanyID != c.CompanyID || ready.Versions != supported {
		return errRejected
	}
	if err := json.NewEncoder(output).Encode(map[string]string{"status": "connected", "outpostId": c.OutpostID, "companyId": c.CompanyID}); err != nil {
		return errors.New("cannot write daemon status")
	}
	if !daemon {
		_ = ws.Close(websocket.StatusNormalClosure, "connection checked")
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(5 * time.Second):
		}
		beatCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err = wsjson.Write(beatCtx, ws, map[string]string{"type": "heartbeat"})
		var reply struct {
			Type string `json:"type"`
		}
		if err == nil {
			err = wsjson.Read(beatCtx, ws, &reply)
		}
		cancel()
		if websocket.CloseStatus(err) == websocket.StatusPolicyViolation {
			return errRejected
		}
		if err != nil {
			return errDisconnected
		}
		if reply.Type != "pong" {
			return errRejected
		}
	}
}
