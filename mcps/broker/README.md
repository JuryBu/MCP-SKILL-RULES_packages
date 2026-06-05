# Portable MCP HTTP Broker

This folder contains the source-only Streamable HTTP broker used by the portable toolkit.

## Endpoints

- `/memory-store/mcp`
- `/web-fetcher/mcp`
- `/sandbox/mcp`
- `/exa/mcp` if Exa remote URL is configured

## Notes

Use the scripts under `install/` to start, stop, check, and test the broker. The receiver should keep runtime logs, pid files, private environment files, and local screenshots outside the packaged source tree.
