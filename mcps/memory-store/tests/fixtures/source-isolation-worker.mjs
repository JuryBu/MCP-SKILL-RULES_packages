import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

process.on("message", message => {
    if (message.type !== "run") return;
    const descendant = message.payload.descendant ? spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }) : undefined;
    process.send({ type: "progress", progress: { phase: "started", bytes: process.pid, totalBytes: descendant?.pid } }, () => {
        if (message.payload.mode === "native") {
            const database = new DatabaseSync(":memory:");
            database.prepare("WITH RECURSIVE count(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM count WHERE value<2000000000) SELECT sum(value) FROM count").get();
        } else if (message.payload.mode === "busy") {
            while (true) Math.sqrt(12345);
        } else {
            process.send({ type: "patch", patch: { type: "set", path: [], value: { ok: true } } }, () => {
                process.send({ type: "complete" }, () => process.disconnect());
            });
        }
    });
});
