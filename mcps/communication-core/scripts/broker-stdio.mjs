import { createMcpStdioFacade } from "../src/mcp-stdio-facade.mjs";

let facade;
async function stop() {
  await facade?.close();
  process.stdin.pause();
}

try {
  facade = await createMcpStdioFacade();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  process.stdout.once("error", stop);
  await facade.connect();
} catch {
  process.stderr.write("communication-core facade startup failed\n");
  process.exitCode = 1;
  await stop();
}
