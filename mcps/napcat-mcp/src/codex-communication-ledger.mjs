import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function ledgerError(code) {
  return Object.assign(new Error(code), { code });
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32" || !["EISDIR", "EACCES", "EPERM", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createCodexCommunicationLedger({ ledgerPath, validateRecord, recoverRecord, uncertainRecord }) {
  const filename = path.resolve(ledgerPath);
  const lockPath = `${filename}.lock`;
  const records = new Map();
  const lockContent = JSON.stringify({ version: 1, pid: process.pid, owner: randomUUID() });
  let lockDescriptor;
  let lockWritten = false;
  let faulted = false;

  function persist() {
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, deliveries: [...records.values()] }), "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filename);
      syncDirectory(path.dirname(filename));
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  function close() {
    if (lockDescriptor === undefined) return;
    try {
      const held = fs.fstatSync(lockDescriptor);
      const current = fs.lstatSync(lockPath);
      if (current.isFile() && held.dev === current.dev && held.ino === current.ino
        && (!lockWritten || fs.readFileSync(lockPath, "utf8") === lockContent)) fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      fs.closeSync(lockDescriptor);
      lockDescriptor = undefined;
    }
  }

  function open() {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    try {
      lockDescriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      throw ledgerError(error.code === "EEXIST" ? "ledger_locked" : "ledger_lock_failed");
    }
    try {
      fs.writeFileSync(lockDescriptor, lockContent, "utf8");
      fs.fsyncSync(lockDescriptor);
      lockWritten = true;
      let serialized;
      try {
        if (!fs.lstatSync(filename).isFile()) throw ledgerError("ledger_invalid");
        serialized = fs.readFileSync(filename, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw ledgerError("ledger_invalid");
      }
      if (serialized !== undefined) {
        let data;
        try {
          data = JSON.parse(serialized, (key, value) => {
            if (["__proto__", "constructor", "prototype"].includes(key)) throw ledgerError("ledger_invalid");
            return value;
          });
          if (!data || data.version !== 1 || !Array.isArray(data.deliveries)
            || Object.keys(data).some(key => !["version", "deliveries"].includes(key))) throw ledgerError("ledger_invalid");
          for (const record of data.deliveries) {
            if (!validateRecord(record) || records.has(record.delivery_id)) throw ledgerError("ledger_invalid");
            records.set(record.delivery_id, record);
          }
        } catch {
          throw ledgerError("ledger_invalid");
        }
      }
      let recovered = false;
      for (const [deliveryId, record] of records) {
        if (["prepared", "dispatching"].includes(record.status)) {
          records.set(deliveryId, recoverRecord(record));
          recovered = true;
        }
      }
      if (serialized === undefined || recovered) persist();
    } catch (error) {
      close();
      throw error;
    }
  }

  return {
    open,
    close,
    get: deliveryId => records.get(deliveryId),
    values: () => records.values(),
    get writable() { return !faulted && lockDescriptor !== undefined; },
    put(record) {
      if (faulted || lockDescriptor === undefined) throw ledgerError("ledger_unavailable");
      records.set(record.delivery_id, record);
      try {
        persist();
        return true;
      } catch {
        faulted = true;
        records.set(record.delivery_id, uncertainRecord(record, "ledger_write_failed"));
        try { persist(); } catch {}
        return false;
      }
    },
  };
}
