# Safari MCP — personal fork

Personal fork of [achiya-automation/safari-mcp](https://github.com/achiya-automation/safari-mcp) (MIT) - a macOS MCP server exposing 98 native Safari automation tools to AI agents. All credit for the server itself goes to the upstream project; this fork tracks upstream code unmodified.

## Why I keep a fork

safari-mcp is the browser-automation layer of my personal AI infrastructure. On my Mac it runs behind a launchd-managed tunnel so cloud AI agents can securely drive my real, logged-in Safari - the same Railway WebSocket tunnel pattern I use across my own MCP servers:

- [apple-data-mcp](https://github.com/dbalchunas2-pixel/apple-data-mcp) - Apple Notes, Calendar, Reminders, iMessage, Mail, Contacts, Obsidian through one authenticated hub
- [apple-health-mcp-tunnel](https://github.com/dbalchunas2-pixel/apple-health-mcp-tunnel) - Apple Health data, local-first
- [pearson-mcp-railway](https://github.com/dbalchunas2-pixel/pearson-mcp-railway) - course platform data
- [railway-manager-mcp](https://github.com/dbalchunas2-pixel/railway-manager-mcp) - managing the Railway services themselves

## Upstream documentation

Everything about installing, configuring, and using the server - all 98 tools, the optional Safari extension, permissions, and troubleshooting - lives in the upstream README:

https://github.com/achiya-automation/safari-mcp

## License

MIT, inherited from upstream.
