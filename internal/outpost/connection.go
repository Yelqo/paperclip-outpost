package outpost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

var errRejected = errors.New("outpost connection rejected: verify registration, revocation and supported versions")
var errAlreadyConnected = errors.New("outpost already connected (HTTP 409): stop the active daemon before running a standalone check or connect; only one connection is allowed")
var errDisconnected = errors.New("outpost connection unavailable: verify instance address, DNS, TLS trust, network connectivity and WebSocket support")

// Before registration, check the same origin and headers without operator or
// access-provider management authority. After registration, check uses WSS.
func checkConnection(c Connection, output io.Writer) error {
	req, err := http.NewRequest(http.MethodGet, c.Instance+"/api/health", nil)
	if err != nil {
		return errors.New("invalid connection settings")
	}
	for name, value := range c.Headers {
		req.Header.Set(name, value)
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return errors.New("connection check failed: verify instance address, DNS, TLS trust and network connectivity")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("connection check rejected (HTTP %d): verify existing access credentials and policies with the operator", res.StatusCode)
	}
	var health struct {
		Status string `json:"status"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&health) != nil || health.Status != "ok" {
		return errors.New("connection check received an unexpected response: verify the Paperclip origin and access-layer configuration")
	}
	return json.NewEncoder(output).Encode(map[string]string{"status": "reachable"})
}

func connect(privateDir string, c Connection, output io.Writer, daemon bool) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var supervisor *supervisor
	if daemon {
		var err error
		supervisor, err = newSupervisor(privateDir, c)
		if err != nil {
			return err
		}
		defer supervisor.lock.Close()
	}
	backoff := time.Second
	for {
		err := session(ctx, c, output, daemon, supervisor)
		if ctx.Err() != nil {
			return nil
		}
		if !daemon || errors.Is(err, errRejected) || errors.Is(err, errAlreadyConnected) {
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

func session(ctx context.Context, c Connection, output io.Writer, daemon bool, s *supervisor) error {
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
		if response != nil && response.StatusCode == http.StatusConflict {
			return errAlreadyConnected
		}
		if response != nil && response.StatusCode >= 300 && response.StatusCode < 500 {
			return fmt.Errorf("%w (HTTP %d): verify existing access credentials and policies; use configure then check before restarting the daemon", errRejected, response.StatusCode)
		}
		return errDisconnected
	}
	defer ws.CloseNow()
	ws.SetReadLimit(64 * 1024)
	var ready struct {
		Type             string   `json:"type"`
		OutpostID        string   `json:"outpostId"`
		CompanyID        string   `json:"companyId"`
		Versions         Versions `json:"versions"`
		RecoveryRequired bool     `json:"recoveryRequired"`
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
	if daemon && ready.RecoveryRequired {
		if err := reconcileSession(ctx, ws, s); err != nil {
			return err
		}
	}
	if err := json.NewEncoder(output).Encode(map[string]string{"status": "connected", "outpostId": c.OutpostID, "companyId": c.CompanyID}); err != nil {
		return errors.New("cannot write daemon status")
	}
	if !daemon {
		_ = ws.Close(websocket.StatusNormalClosure, "connection checked")
		return nil
	}
	var writeMu sync.Mutex
	sessionCtx, endSession := context.WithCancel(ctx)
	defer endSession()
	write := func(value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		writeCtx, cancel := context.WithTimeout(sessionCtx, 10*time.Second)
		defer cancel()
		return wsjson.Write(writeCtx, ws, value)
	}
	type incoming struct {
		Type       string      `json:"type"`
		DeliveryID string      `json:"deliveryId"`
		Operations []operation `json:"operations"`
	}
	pongs := make(chan incoming, 1)
	acks := make(chan string, 1)
	failures := make(chan error, 1)
	go func() {
		for {
			var reply incoming
			if err := wsjson.Read(sessionCtx, ws, &reply); err != nil {
				failures <- err
				return
			}
			switch reply.Type {
			case "ack":
				select {
				case acks <- reply.DeliveryID:
				case <-sessionCtx.Done():
					return
				}
			case "pong":
				select {
				case pongs <- reply:
				case <-sessionCtx.Done():
					return
				}
			default:
				failures <- errRejected
				return
			}
		}
	}()
	// Bound machine-to-host delivery to one acknowledged frame at a time. This
	// backpressure keeps a fast child below core's worker-delivery queue limit.
	var deliveryMu sync.Mutex
	sequence := 0
	send := func(value any) error {
		deliveryMu.Lock()
		defer deliveryMu.Unlock()
		sequence++
		id := fmt.Sprint(sequence)
		value.(map[string]any)["deliveryId"] = id
		if err := write(value); err != nil {
			return err
		}
		select {
		case ack := <-acks:
			if ack == id {
				return nil
			}
			return errRejected
		case <-sessionCtx.Done():
			return errDisconnected
		case <-time.After(10 * time.Second):
			endSession()
			return errDisconnected
		}
	}
	for {
		reports, reportErr := s.recoveryReports(false)
		if reportErr != nil {
			return reportErr
		}
		for _, record := range reports {
			if err := send(map[string]any{"type": "history", "record": record}); err != nil {
				return errDisconnected
			}
		}
		if err = write(map[string]string{"type": "heartbeat"}); err != nil {
			return errDisconnected
		}
		var reply incoming
		select {
		case reply = <-pongs:
		case err = <-failures:
			if websocket.CloseStatus(err) == websocket.StatusPolicyViolation || errors.Is(err, errRejected) {
				return errRejected
			}
			return errDisconnected
		case <-ctx.Done():
			return nil
		case <-time.After(10 * time.Second):
			return errDisconnected
		}
		for _, op := range reply.Operations {
			go s.handle(ctx, op, send)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(100 * time.Millisecond):
		}
	}
}
