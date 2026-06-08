import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.SUBAGENT_DATA_DIR || path.resolve("subagent-data");
const REGISTRY_PATH = process.env.SUBAGENT_REGISTRY_PATH || path.join(DATA_DIR, "jobs.json");
const LOCK_PATH = process.env.SUBAGENT_REGISTRY_LOCK_PATH || path.join(DATA_DIR, "jobs.lock");

let writeQueue = Promise.resolve();

export function getRegistryPath() {
  return REGISTRY_PATH;
}

export function getDataDir() {
  return DATA_DIR;
}

export async function ensureDataDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, "archive"), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, "archive-exports"), { recursive: true });
}

function emptyRegistry() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    owner_workspace: process.cwd(),
    jobs: {},
    archives: {},
  };
}

export async function readRegistry() {
  await ensureDataDirs();
  try {
    const text = await fs.readFile(REGISTRY_PATH, "utf8");
    const registry = JSON.parse(text);
    if (registry.version !== 1 || !registry.jobs) {
      throw new Error("Unsupported registry version or shape");
    }
    return registry;
  } catch (error) {
    if (error.code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function pidExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(operation) {
  await ensureDataDirs();
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const handle = await fs.open(LOCK_PATH, "wx");
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        operation,
        created_at: new Date().toISOString(),
      }, null, 2));
      return handle;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(await fs.readFile(LOCK_PATH, "utf8"));
        const age = Date.now() - Date.parse(lock.created_at || 0);
        if (age > 30000 && !(await pidExists(lock.pid))) {
          await fs.rm(LOCK_PATH, { force: true });
          continue;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out acquiring registry lock for ${operation}`);
}

async function releaseLock(handle) {
  try {
    await handle.close();
  } catch {}
  await fs.rm(LOCK_PATH, { force: true });
}

async function writeRegistryFile(registry) {
  registry.updated_at = new Date().toISOString();
  const tempPath = path.join(DATA_DIR, `jobs.json.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tempPath, JSON.stringify(registry, null, 2), "utf8");
  if (await pathExists(REGISTRY_PATH)) {
    const backupPath = path.join(DATA_DIR, `jobs.json.prev-${process.pid}-${Date.now()}`);
    await fs.rename(REGISTRY_PATH, backupPath);
    try {
      await fs.rename(tempPath, REGISTRY_PATH);
      await fs.rm(backupPath, { force: true });
    } catch (error) {
      if (await pathExists(backupPath)) {
        await fs.rename(backupPath, REGISTRY_PATH);
      }
      throw error;
    }
  } else {
    await fs.rename(tempPath, REGISTRY_PATH);
  }
}

export async function mutateRegistry(operation, mutator) {
  const run = async () => {
    const lock = await acquireLock(operation);
    try {
      const registry = await readRegistry();
      const result = await mutator(registry);
      await writeRegistryFile(registry);
      return result;
    } finally {
      await releaseLock(lock);
    }
  };
  writeQueue = writeQueue.then(run, run);
  return await writeQueue;
}

export function createJobId() {
  return `wsf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function upsertJob(job) {
  return await mutateRegistry("upsertJob", async (registry) => {
    registry.jobs[job.job_id] = job;
    return job;
  });
}

export async function updateJob(jobId, updater) {
  return await mutateRegistry("updateJob", async (registry) => {
    const job = registry.jobs[jobId];
    if (!job) throw new Error(`Unknown job_id=${jobId}`);
    const result = await updater(job, registry);
    job.updated_at = new Date().toISOString();
    return result ?? job;
  });
}

export async function getJob(jobId) {
  const registry = await readRegistry();
  return registry.jobs[jobId] || null;
}

export async function listJobs(filter = "active") {
  const registry = await readRegistry();
  const jobs = Object.values(registry.jobs);
  if (filter === "all") return jobs;
  if (filter === "archived") return jobs.filter((job) => job.state === "archived" || job.state === "deleted");
  if (filter === "done") return jobs.filter((job) => ["done", "collected", "collect_failed", "timeout"].includes(job.state));
  return jobs.filter((job) => !["archived", "deleted"].includes(job.state));
}
