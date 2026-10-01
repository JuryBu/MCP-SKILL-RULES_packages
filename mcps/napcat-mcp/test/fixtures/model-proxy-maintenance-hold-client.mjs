const port = Number(process.argv[2]);
const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "owned-fixture", input: [], stream: true, fixture_hold: true }),
});
const output = await response.text();
if (!response.ok || !output.includes("response.completed")) process.exitCode = 1;
else process.stdout.write("OWNED_HOLD_COMPLETED\n");
