import * as nodeFs from 'node:fs/promises';
import { dirname } from 'node:path';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENDPOINTS = new Set(['responses', 'compact', 'unsupported']);
const PROTOCOLS = new Set(['pending', 'sse', 'json', 'unsupported']);
const PHASES = new Set(['request.parsed', 'request.submitted', 'upstream.headers', 'response.created', 'response.in_progress', 'response.completed', 'response.failed', 'response.incomplete', 'response.json', 'request.ended', 'proxy.synthetic', 'unsupported']);
const SOURCES = new Set(['proxy_forward', 'upstream', 'proxy_lifecycle', 'proxy_synthetic']);
const OUTCOMES = new Set(['in_progress', 'completed', 'failed', 'cancelled', 'ended_unknown']);
const MODEL_FIELDS = ['proxy_input_model', 'forwarded_model', 'upstream_response_model', 'upstream_header_model'];
const ERROR_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EBUSY', 'EMFILE', 'ENOENT', 'EROFS']);
const MAX_RECORD_BYTES = 2048;
const CLOSE_TIMEOUT_MS = 1500;

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function safeCode(error) {
  return ERROR_CODES.has(error?.code) ? error.code : 'WRITE_FAILED';
}

export function createModelObserver({ filePath, statusPath, producerInstance, now = Date.now, maxQueue = 1024, maxFileBytes = 4 * 1024 * 1024, rotations = 7, heartbeatMs = 1000, fsAdapter = nodeFs } = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof statusPath !== 'string' || !statusPath || filePath === statusPath || typeof producerInstance !== 'string' || !UUID.test(producerInstance)) {
    throw new TypeError('filePath, distinct statusPath and UUID producerInstance are required');
  }
  const queueLimit = boundedInteger(maxQueue, 1024, 1, 10000);
  const fileLimit = boundedInteger(maxFileBytes, 4 * 1024 * 1024, 256, 1024 * 1024 * 1024);
  const rotationLimit = boundedInteger(rotations, 7, 0, 32);
  const heartbeat = boundedInteger(heartbeatMs, 1000, 10, 60000);
  const filesystem = fsAdapter;
  const clock = () => {
    try {
      const value = now();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    } catch {}
    return new Date().toISOString();
  };
  const startedAt = clock();
  const queue = [];
  const waiters = [];
  let closed = false;
  let closePromise;
  let draining = false;
  let drainScheduled = false;
  let inFlight = false;
  let statusPromise;
  let statusDirty = false;
  let acceptedSerial = 0;
  let completedSerial = 0;
  let dropped = 0;
  let writeErrors = 0;
  let lastWriteAt = null;
  let lastFlushedAt = null;
  let coverageStart = startedAt;
  let coverageEnd = null;
  let lastErrorCode = null;

  function status() {
    return {
      schema_version: 2,
      producer_instance: producerInstance,
      producer_version: 'passive-v2',
      updated_at: clock(),
      running: !closed,
      capture_enabled: !closed && dropped === 0 && writeErrors === 0,
      scope: 'guarded-http-v2',
      started_at: startedAt,
      dropped,
      write_errors: writeErrors,
      queue_depth: queue.length + Number(inFlight),
      last_write_at: lastWriteAt,
      coverage_start: coverageStart,
      coverage_end: coverageEnd,
      last_error_code: lastErrorCode,
    };
  }

  function incrementDropped(code) {
    dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
    lastErrorCode = code;
    requestStatusWrite();
  }

  function incrementWriteError(error) {
    writeErrors = Math.min(Number.MAX_SAFE_INTEGER, writeErrors + 1);
    lastErrorCode = safeCode(error);
    requestStatusWrite();
  }

  async function writeStatusOnce() {
    const temporaryPath = `${statusPath}.${producerInstance}.tmp`;
    try {
      await filesystem.mkdir(dirname(statusPath), { recursive: true });
      await filesystem.writeFile(temporaryPath, `${JSON.stringify(status())}\n`, 'utf8');
      await filesystem.rename(temporaryPath, statusPath);
    } catch (error) {
      writeErrors = Math.min(Number.MAX_SAFE_INTEGER, writeErrors + 1);
      lastErrorCode = safeCode(error);
    }
  }

  function requestStatusWrite() {
    statusDirty = true;
    if (!statusPromise) {
      statusPromise = (async () => {
        do {
          statusDirty = false;
          await writeStatusOnce();
        } while (statusDirty);
      })().catch((error) => {
        writeErrors = Math.min(Number.MAX_SAFE_INTEGER, writeErrors + 1);
        lastErrorCode = safeCode(error);
      }).finally(() => {
        statusPromise = undefined;
        if (statusDirty) requestStatusWrite();
      });
    }
    return statusPromise;
  }

  async function rotate() {
    if (rotationLimit === 0) {
      await filesystem.writeFile(filePath, '', 'utf8');
    } else {
      for (let index = rotationLimit; index >= 1; index -= 1) {
        const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
        const target = `${filePath}.${index}`;
        try {
          await filesystem.rename(source, target);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
    coverageStart = clock();
    coverageEnd = null;
  }

  async function sizeBefore(bytes) {
    await filesystem.mkdir(dirname(filePath), { recursive: true });
    let size = 0;
    try {
      size = (await filesystem.stat(filePath)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (size > 0 && size + bytes > fileLimit) {
      await rotate();
      return true;
    }
    return false;
  }

  async function appendEvent(item) {
    await sizeBefore(item.bytes);
    await filesystem.appendFile(filePath, item.line, 'utf8');
    lastWriteAt = clock();
    lastFlushedAt = lastWriteAt;
  }

  async function appendCoverage() {
    if (dropped || writeErrors || !lastFlushedAt || lastFlushedAt <= coverageStart || lastFlushedAt <= (coverageEnd ?? '')) return;
    let boundary = lastFlushedAt;
    let marker = {
      type: 'model_watch_coverage', schema_version: 2, producer_instance: producerInstance,
      start: coverageEnd ?? coverageStart, end: boundary, dropped: 0, model_capture: true,
      scope: 'guarded-http-v2', producer_version: 'passive-v2',
    };
    let line = `${JSON.stringify(marker)}\n`;
    if (await sizeBefore(Buffer.byteLength(line, 'utf8'))) {
      if (boundary <= coverageStart) return;
      marker = { ...marker, start: coverageStart };
      line = `${JSON.stringify(marker)}\n`;
    }
    await filesystem.appendFile(filePath, line, 'utf8');
    coverageEnd = boundary;
    lastWriteAt = clock();
  }

  function settleWaiters() {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (completedSerial >= waiters[index].serial) {
        waiters[index].resolve();
        waiters.splice(index, 1);
      }
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        inFlight = true;
        try {
          if (item.kind === 'coverage') await appendCoverage();
          else await appendEvent(item);
        } catch (error) {
          incrementWriteError(error);
          if (item.kind === 'event') incrementDropped(safeCode(error));
        } finally {
          inFlight = false;
          if (item.kind === 'event') {
            completedSerial = item.serial;
            settleWaiters();
          } else {
            item.resolve();
          }
        }
      }
    } catch (error) {
      incrementWriteError(error);
      while (queue.length) {
        const item = queue.shift();
        if (item.kind === 'event') {
          incrementDropped('WRITE_FAILED');
          completedSerial = item.serial;
        } else item.resolve();
      }
      settleWaiters();
    } finally {
      draining = false;
      requestStatusWrite();
      if (queue.length) startDrain();
    }
  }

  function startDrain() {
    if (draining || drainScheduled) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      void drain().catch(incrementWriteError);
    });
  }

  function observe(record) {
    try {
      if (closed || !record || typeof record !== 'object') {
        incrementDropped(closed ? 'CLOSED' : 'INVALID_RECORD');
        return false;
      }
      const requestId = record.request_id;
      const upstreamAttempt = record.upstream_attempt;
      const source = record.observation_source;
      if (typeof requestId !== 'string' || !UUID.test(requestId) || !Number.isSafeInteger(upstreamAttempt) || upstreamAttempt < 0 || upstreamAttempt > 10000 || !SOURCES.has(source) || !ENDPOINTS.has(record.endpoint) || !PROTOCOLS.has(record.protocol) || !PHASES.has(record.phase) || !OUTCOMES.has(record.outcome)) {
        incrementDropped('INVALID_RECORD');
        return false;
      }
      const item = {
        type: 'model_observation', schema_version: 2, producer_instance: producerInstance,
        request_id: requestId, upstream_attempt: upstreamAttempt,
        native_attempt: Number.isSafeInteger(record.native_attempt) && record.native_attempt >= 0 && record.native_attempt <= 10000 ? record.native_attempt : null,
        at: clock(), endpoint: record.endpoint, protocol: record.protocol, phase: record.phase,
        observation_source: source, request_sent: record.request_sent === true, outcome: record.outcome,
      };
      let invalidFields = boundedInteger(record.invalid_fields, 0, 0, 10000);
      for (const field of MODEL_FIELDS) {
        const value = record[field];
        if (value == null) continue;
        if (typeof value !== 'string' || !MODEL.test(value)) {
          invalidFields += 1;
          continue;
        }
        if (source !== 'proxy_synthetic' && (!field.startsWith('upstream_') || source === 'upstream')) item[field] = value;
      }
      if (invalidFields) item.invalid_fields = invalidFields;
      const line = `${JSON.stringify(item)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > MAX_RECORD_BYTES) {
        incrementDropped('RECORD_TOO_LARGE');
        return false;
      }
      if (queue.length + Number(inFlight) >= queueLimit) {
        incrementDropped('QUEUE_FULL');
        return false;
      }
      queue.push({ kind: 'event', line, bytes, serial: ++acceptedSerial });
      startDrain();
      return true;
    } catch {
      incrementDropped('INVALID_RECORD');
      return false;
    }
  }

  function waitForSerial(serial) {
    if (completedSerial >= serial) return Promise.resolve();
    return new Promise((resolve) => waiters.push({ serial, resolve }));
  }

  async function flush() {
    await waitForSerial(acceptedSerial);
    await new Promise((resolve) => {
      queue.push({ kind: 'coverage', resolve });
      startDrain();
    });
    await requestStatusWrite();
  }

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    clearInterval(timer);
    closePromise = (async () => {
      let timeout;
      const finished = await Promise.race([
        flush().then(() => true, () => false),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS); }),
      ]);
      clearTimeout(timeout);
      if (!finished) {
        writeErrors = Math.min(Number.MAX_SAFE_INTEGER, writeErrors + 1);
        lastErrorCode = 'WRITE_TIMEOUT';
      }
      await Promise.race([
        requestStatusWrite(),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
      return finished;
    })();
    return closePromise;
  }

  const timer = setInterval(() => {
    requestStatusWrite();
    if (!queue.length && !inFlight && !dropped && !writeErrors && lastFlushedAt && lastFlushedAt > (coverageEnd ?? coverageStart)) {
      queue.push({ kind: 'coverage', resolve() {} });
      startDrain();
    }
  }, heartbeat);
  timer.unref?.();
  requestStatusWrite();
  startDrain();
  return { observe, status, flush, close };
}
