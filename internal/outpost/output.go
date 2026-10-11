package outpost

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const defaultOutputBufferBytes int64 = 2 * 1024 * 1024
const defaultOutputTotalBytes int64 = 64 * 1024 * 1024
const maxOutputSpools = 1024

var errOutputLimit = errors.New("output limit exceeded")

type outputIdentity struct {
	RequestID   string `json:"requestId"`
	RunID       string `json:"runId"`
	OperationID string `json:"operationId"`
}

type outputSpool struct {
	outputIdentity
	path     string
	size     int64
	offset   int64
	sequence uint64
}

// Only identities and cursors live in memory. Output is fsynced before delivery;
// the separate durable cursor advances only after Paperclip's acknowledgement.
type outputStore struct {
	mu         sync.Mutex
	deliveryMu sync.Mutex
	dir        string
	limit      int64
	totalLimit int64
	bytes      int64
	spools     map[string]*outputSpool
}

func (store *outputStore) retention() map[string]any {
	store.mu.Lock()
	defer store.mu.Unlock()
	return map[string]any{"bytes": store.bytes, "operations": len(store.spools), "perOperationBytes": store.limit, "totalBytes": store.totalLimit, "maxOperations": maxOutputSpools}
}

func openOutputStore(dir string, limit, totalLimit int64) (*outputStore, error) {
	if limit == 0 {
		limit = defaultOutputBufferBytes
	}
	if totalLimit == 0 {
		totalLimit = defaultOutputTotalBytes
	}
	if limit < 4096 || limit > defaultOutputTotalBytes || totalLimit < limit || totalLimit > 1024*1024*1024 {
		return nil, errors.New("output bounds require 4096 <= per-operation <= total <= 1 GiB, with per-operation <= 64 MiB")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	store := &outputStore{dir: dir, limit: limit, totalLimit: totalLimit, spools: map[string]*outputSpool{}}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".output.tmp") {
			if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
				return nil, err
			}
			continue
		}
		if strings.HasSuffix(entry.Name(), ".ack") || strings.HasSuffix(entry.Name(), ".ack.tmp") {
			outputPath := strings.TrimSuffix(strings.TrimSuffix(entry.Name(), ".tmp"), ".ack")
			if _, err := os.Stat(filepath.Join(dir, outputPath)); os.IsNotExist(err) {
				if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
					return nil, err
				}
			}
			continue
		}
		if filepath.Ext(entry.Name()) != ".output" {
			continue
		}
		if len(store.spools) >= maxOutputSpools {
			return nil, errors.New("too many retained output spools")
		}
		path := filepath.Join(dir, entry.Name())
		file, err := os.OpenFile(path, os.O_RDWR, 0600)
		if err != nil {
			return nil, err
		}
		spool, err := readOutputSpool(file, path)
		file.Close()
		if err != nil {
			return nil, err
		}
		store.spools[spool.OperationID] = spool
		store.bytes += spool.size
	}
	// Lowering configured bounds does not discard already retained output. New
	// appends fail until acknowledgements reclaim enough capacity.
	return store, nil
}

func readOutputSpool(file *os.File, path string) (*outputSpool, error) {
	reader := bufio.NewReader(file)
	header, err := reader.ReadBytes('\n')
	var identity outputIdentity
	if err != nil || len(header) > 4096 || json.Unmarshal(header, &identity) != nil || identity.OperationID == "" || identity.RunID == "" || identity.RequestID == "" {
		return nil, errors.New("invalid retained output identity")
	}
	spool := &outputSpool{outputIdentity: identity, path: path, size: int64(len(header)), offset: int64(len(header))}
	ack, err := os.ReadFile(path + ".ack")
	if err == nil {
		if len(ack) != 16 {
			return nil, errors.New("invalid output acknowledgement")
		}
		spool.offset = int64(binary.BigEndian.Uint64(ack[:8]))
		spool.sequence = binary.BigEndian.Uint64(ack[8:])
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	var sequence uint64
	ackValid := spool.offset == spool.size && spool.sequence == 0
	for {
		var frameHeader [5]byte
		_, err := io.ReadFull(reader, frameHeader[:])
		if err == io.EOF {
			break
		}
		if err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return nil, err
		}
		length := binary.BigEndian.Uint32(frameHeader[1:])
		if frameHeader[0] > 1 || length == 0 || length > 2048 {
			return nil, errors.New("invalid retained output frame")
		}
		if _, err = io.CopyN(io.Discard, reader, int64(length)); err == io.EOF {
			break
		} else if err != nil {
			return nil, err
		}
		spool.size += 5 + int64(length)
		sequence++
		if spool.offset == spool.size && spool.sequence == sequence {
			ackValid = true
		}
	}
	if !ackValid {
		return nil, errors.New("output acknowledgement exceeds retained data")
	}
	// An append interrupted by a daemon crash was never eligible for delivery.
	// Its operation is interrupted by process reconciliation, never successful.
	if err := file.Truncate(spool.size); err != nil {
		return nil, err
	}
	if err := file.Sync(); err != nil {
		return nil, err
	}
	return spool, nil
}

func (store *outputStore) create(op operation, checkpoint func(string)) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.spools) >= maxOutputSpools {
		return errOutputLimit
	}
	identity := outputIdentity{op.RequestID, op.RunID, op.OperationID}
	header, err := json.Marshal(identity)
	if err != nil || len(header) > 4095 {
		return errors.New("execution identity exceeds output transport limit")
	}
	header = append(header, '\n')
	if store.bytes+int64(len(header)) > store.totalLimit {
		return errOutputLimit
	}
	hash := sha256.Sum256([]byte(op.OperationID))
	path := filepath.Join(store.dir, hex.EncodeToString(hash[:])+".output")
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	committed := false
	published := false
	defer func() {
		if !committed {
			_ = os.Remove(temporary)
			if published {
				_ = os.Remove(path)
			}
			_ = syncDirectory(store.dir)
		}
	}()
	checkpoint("before-output-header")
	_, err = file.Write(header)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	checkpoint("after-output-header")
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	published = true
	if err := syncDirectory(store.dir); err != nil {
		return err
	}
	store.spools[op.OperationID] = &outputSpool{outputIdentity: identity, path: path, size: int64(len(header)), offset: int64(len(header))}
	store.bytes += int64(len(header))
	committed = true
	return nil
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (store *outputStore) append(id, stream string, data []byte) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	spool := store.spools[id]
	if spool == nil {
		return errors.New("output retention unavailable")
	}
	for offset := 0; offset < len(data); offset += 2048 {
		end := offset + 2048
		if end > len(data) {
			end = len(data)
		}
		length := end - offset
		if spool.size+int64(5+length) > store.limit || store.bytes+int64(5+length) > store.totalLimit {
			return errOutputLimit
		}
		frame := make([]byte, 5+length)
		if stream == "stderr" {
			frame[0] = 1
		}
		binary.BigEndian.PutUint32(frame[1:5], uint32(length))
		copy(frame[5:], data[offset:end])
		file, err := os.OpenFile(spool.path, os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return err
		}
		_, err = file.Write(frame)
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
		spool.size += int64(len(frame))
		store.bytes += int64(len(frame))
	}
	return nil
}

func (store *outputStore) next(id string) (map[string]any, int64, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	spool := store.spools[id]
	if spool == nil || spool.offset == spool.size {
		return nil, 0, nil
	}
	file, err := os.Open(spool.path)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	var header [5]byte
	if _, err = file.ReadAt(header[:], spool.offset); err != nil {
		return nil, 0, err
	}
	data := make([]byte, binary.BigEndian.Uint32(header[1:]))
	if _, err = file.ReadAt(data, spool.offset+5); err != nil {
		return nil, 0, err
	}
	stream := "stdout"
	if header[0] == 1 {
		stream = "stderr"
	}
	return map[string]any{"type": "output", "requestId": spool.RequestID, "runId": spool.RunID, "operationId": id,
		"sequence": spool.sequence + 1, "stream": stream, "data": base64.StdEncoding.EncodeToString(data)}, spool.offset + 5 + int64(len(data)), nil
}

func (store *outputStore) acknowledge(id string, offset int64) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	spool := store.spools[id]
	var cursor [16]byte
	binary.BigEndian.PutUint64(cursor[:8], uint64(offset))
	binary.BigEndian.PutUint64(cursor[8:], spool.sequence+1)
	path := spool.path + ".ack"
	file, err := os.OpenFile(path+".tmp", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(cursor[:])
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(path+".tmp", path)
	}
	if err == nil {
		err = syncDirectory(store.dir)
	}
	if err != nil {
		return err
	}
	spool.offset = offset
	spool.sequence++
	return nil
}

func (store *outputStore) remove(id string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	spool := store.spools[id]
	if err := os.Remove(spool.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	// Removing output first makes a crash during reclamation leave, at worst,
	// an unused cursor. Terminal consumption history is never removed.
	for _, path := range []string{spool.path + ".ack", spool.path + ".ack.tmp"} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := syncDirectory(store.dir); err != nil {
		return err
	}
	store.bytes -= spool.size
	delete(store.spools, id)
	return nil
}

func (s *supervisor) deliverOutputs(send func(any) error) error {
	s.outputs.deliveryMu.Lock()
	defer s.outputs.deliveryMu.Unlock()
	// Reservation failures have no spool. Deliver their durable terminal
	// receipts first so full or unacknowledged output cannot block them.
	if err := s.deliverPendingResults(send); err != nil {
		return err
	}
	s.outputs.mu.Lock()
	ids := make([]string, 0, len(s.outputs.spools))
	for id := range s.outputs.spools {
		ids = append(ids, id)
	}
	s.outputs.mu.Unlock()
	for _, id := range ids {
		for {
			frame, offset, err := s.outputs.next(id)
			if err != nil {
				return err
			}
			if frame == nil {
				break
			}
			if err := send(frame); err != nil {
				return err
			}
			if err := s.outputs.acknowledge(id, offset); err != nil {
				return err
			}
		}
		s.mu.Lock()
		record := s.records[id]
		s.mu.Unlock()
		if record.Outcome == nil {
			continue
		}
		s.outputs.mu.Lock()
		spool := s.outputs.spools[id]
		complete := spool.offset == spool.size
		frame := map[string]any{"type": "result", "requestId": spool.RequestID, "runId": spool.RunID, "operationId": id, "result": *record.Outcome, "record": record}
		s.outputs.mu.Unlock()
		if !complete {
			continue
		}
		if err := send(frame); err != nil {
			return err
		}
		if s.fault != nil {
			s.fault("after-ack")
		}
		if err := s.outputs.remove(id); err != nil {
			return err
		}
	}
	return nil
}

func (s *supervisor) deliverPendingResults(send func(any) error) error {
	s.mu.Lock()
	var pending []executionRecord
	for _, record := range s.records {
		if record.PendingResultRequestID != "" && record.Outcome != nil && !record.Outcome.OwnershipUncertain {
			pending = append(pending, record)
		}
	}
	s.mu.Unlock()
	for _, record := range pending {
		frame := map[string]any{"type": "result", "requestId": record.PendingResultRequestID, "runId": record.RunID,
			"operationId": record.OperationID, "result": *record.Outcome, "record": record}
		if err := send(frame); err != nil {
			return err
		}
		if s.fault != nil {
			s.fault("after-ack")
		}
		s.mu.Lock()
		current := s.records[record.OperationID]
		if current.PendingResultRequestID != record.PendingResultRequestID {
			s.mu.Unlock()
			continue
		}
		current.PendingResultRequestID = ""
		err := s.persist(current, false)
		if err == nil {
			s.records[record.OperationID] = current
		}
		s.mu.Unlock()
		if err != nil {
			return err
		}
	}
	return nil
}
