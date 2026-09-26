import fs from "node:fs";
import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode === "normal") {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ args: process.argv.slice(3), input }));
        process.stderr.write("stderr-ok");
        process.exitCode = 7;
    });
} else if (mode === "descendant") {
    process.stdout.write("child-alive\n");
    setInterval(() => {}, 1000);
} else if (mode === "orphan" || mode === "cancel") {
    const child = spawn(process.execPath, [process.argv[1], "descendant"], {
        stdio: ["ignore", "inherit", "inherit"], detached: true, windowsHide: true,
    });
    fs.writeFileSync(process.argv[3], String(child.pid));
    child.unref();
    if (mode === "orphan") setTimeout(() => process.exit(0), 100);
    else setInterval(() => {}, 1000);
} else {
    process.exitCode = 11;
}
