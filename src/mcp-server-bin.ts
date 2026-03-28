#!/usr/bin/env node
import { startMcpServer } from "./mcp-server.js";
startMcpServer().catch(console.error);
