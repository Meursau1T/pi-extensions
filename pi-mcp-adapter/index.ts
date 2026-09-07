import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { Type } from "typebox";
import { showStatus, showTools, reconnectServers, authenticateServer, logoutServer, openMcpAuthPanel, openMcpPanel, openMcpSetup } from "./commands.ts";
import {
  getServerProvenance,
  getServerStateOverrides,
  loadMcpConfig,
  updateServerStateOverrides,
} from "./config.ts";
import { buildProxyDescription, createDirectToolExecutor, getMissingConfiguredDirectToolServers, resolveDirectTools } from "./direct-tools.ts";
import { flushMetadataCache, getFailureAgeSeconds, initializeMcp, updateStatusBar } from "./init.ts";
import { isServerCacheValid, loadMetadataCache, reconstructToolMetadata } from "./metadata-cache.ts";
import { executeAuthComplete, executeAuthStart, executeCall, executeConnect, executeDescribe, executeList, executeSearch, executeStatus, executeUiMessages } from "./proxy-modes.ts";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.ts";
import { initializeOAuth, shutdownOAuth } from "./mcp-auth-flow.ts";
import { createMcpDirectToolCallRenderer, renderMcpProxyToolCall, renderMcpToolResult } from "./tool-result-renderer.ts";
import { isServerEnabled } from "./types.ts";

interface CapabilityBridgeServer {
  name: string;
  enabled: boolean;
  status: "connected" | "needs-auth" | "failed" | "cached" | "idle" | "disabled" | "stale-cache";
  toolCount: number;
  directToolCount: number;
  cacheValid: boolean;
  source: "user" | "project" | "import" | "cache";
  importKind?: string;
  globalOverride?: boolean;
  projectOverride?: boolean;
}

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let lifecycleGeneration = 0;
  let sessionCwd = process.cwd();

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;

    if (currentState.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    try {
      flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directSpecs = envRaw === "__none__"
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map(s => s.trim()).filter(Boolean),
      );
  const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(earlyConfig, earlyCache);
  const hasEnabledServers = Object.keys(earlyConfig.mcpServers).some(
    (name) => isServerEnabled(earlyConfig, name),
  );
  const shouldRegisterProxyTool = hasEnabledServers && (
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0
  );

  for (const spec of directSpecs) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: Type.Unsafe((spec.inputSchema || { type: "object", properties: {} }) as never),
      execute: createDirectToolExecutor(() => state, () => initPromise, spec),
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
      renderResult: renderMcpToolResult,
    });
  }

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  function buildCapabilitiesSnapshot(cwd: string) {
    const config = loadMcpConfig(earlyConfigPath, cwd);
    const cache = loadMetadataCache();
    const overrides = getServerStateOverrides(earlyConfigPath, cwd);
    const provenance = getServerProvenance(earlyConfigPath, cwd);
    const currentDirectSpecs = resolveDirectTools(config, cache, config.settings?.toolPrefix ?? "server");

    const servers: CapabilityBridgeServer[] = Object.entries(config.mcpServers).map(([name, definition]) => {
      const enabled = isServerEnabled(config, name);
      const cached = cache?.servers?.[name];
      const cacheValid = !!cached && isServerCacheValid(cached, definition);
      const metadata = cacheValid
        ? reconstructToolMetadata(name, cached, config.settings?.toolPrefix ?? "server", definition)
        : [];
      const connection = state?.manager.getConnection(name);
      const failedAgo = state ? getFailureAgeSeconds(state, name) : null;
      let status: CapabilityBridgeServer["status"] = enabled ? "idle" : "disabled";
      if (enabled && connection?.status === "connected") status = "connected";
      else if (enabled && connection?.status === "needs-auth") status = "needs-auth";
      else if (enabled && failedAgo !== null) status = "failed";
      else if (enabled && cacheValid) status = "cached";

      const source = provenance.get(name);
      return {
        name,
        enabled,
        status,
        toolCount: metadata.length,
        directToolCount: currentDirectSpecs.filter((spec) => spec.serverName === name).length,
        cacheValid,
        source: source?.kind ?? "user",
        importKind: source?.importKind,
        globalOverride: overrides.global[name],
        projectOverride: overrides.project[name],
      };
    });

    for (const [name, cached] of Object.entries(cache?.servers ?? {})) {
      if (config.mcpServers[name]) continue;
      servers.push({
        name,
        enabled: false,
        status: "stale-cache",
        toolCount: (cached.tools?.length ?? 0) + (cached.resources?.length ?? 0),
        directToolCount: 0,
        cacheValid: false,
        source: "cache",
        importKind: undefined,
        globalOverride: undefined,
        projectOverride: undefined,
      });
    }

    return { version: 1, servers };
  }

  pi.events.on("pi-mcp-adapter:capabilities:get", (payload) => {
    const request = payload as { cwd?: unknown; respond?: unknown } | undefined;
    if (typeof request?.respond !== "function") return;
    const cwd = typeof request.cwd === "string" ? request.cwd : sessionCwd;
    request.respond(buildCapabilitiesSnapshot(cwd));
  });

  pi.events.on("pi-mcp-adapter:capabilities:update", (payload) => {
    const request = payload as {
      cwd?: unknown;
      scope?: unknown;
      changes?: unknown;
      respond?: unknown;
    } | undefined;
    if (typeof request?.respond !== "function") return;
    if (request.scope !== "global" && request.scope !== "project") {
      request.respond({ ok: false, error: "Invalid MCP capability scope" });
      return;
    }
    if (!request.changes || typeof request.changes !== "object" || Array.isArray(request.changes)) {
      request.respond({ ok: false, error: "Invalid MCP capability changes" });
      return;
    }

    const changes: Record<string, boolean | null> = {};
    for (const [name, value] of Object.entries(request.changes as Record<string, unknown>)) {
      if (value === true || value === false || value === null) changes[name] = value;
    }

    try {
      const cwd = typeof request.cwd === "string" ? request.cwd : sessionCwd;
      const path = updateServerStateOverrides(changes, request.scope, earlyConfigPath, cwd);
      request.respond({ ok: true, path });
    } catch (error) {
      request.respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;

    try {
      await Promise.all([
        shutdownState(previousState, "session_restart"),
        shutdownOAuth(),
      ]);
    } catch (error) {
      console.error("MCP: failed to shut down previous session state", error);
    }

    if (generation !== lifecycleGeneration) {
      return;
    }

    await initializeOAuth().catch(err => {
      console.error("MCP OAuth initialization failed:", err);
    });

    const promise = initializeMcp(pi, ctx);
    initPromise = promise;

    promise.then(async (nextState) => {
      if (generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, "stale_session_start");
        } catch (error) {
          console.error("MCP: failed to clean stale session state", error);
        }
        return;
      }

      state = nextState;
      updateStatusBar(nextState);
      initPromise = null;
    }).catch(err => {
      if (generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      console.error("MCP initialization failed:", err);
      initPromise = null;
    });
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    state = null;
    initPromise = null;

    try {
      await Promise.all([
        shutdownState(currentState, "session_shutdown"),
        shutdownOAuth(),
      ]);
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
  });

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "setup": {
          const result = await openMcpSetup(state, pi, ctx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          await logoutServer(serverName, state, ctx);
          break;
        }
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            const result = await openMcpPanel(state, pi, ctx, earlyConfigPath);
            if (result?.configChanged) {
              await ctx.reload();
              return;
            }
          } else {
            await showStatus(state, ctx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) {
        return;
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      if (!serverName) {
        await openMcpAuthPanel(state, pi, ctx, earlyConfigPath);
        return;
      }

      await authenticateServer(serverName, state.config, ctx);
    },
  });

  if (shouldRegisterProxyTool) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      renderCall: renderMcpProxyToolCall,
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
        args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
        connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
        describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
        search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
        action: Type.Optional(Type.String({ description: "Action: 'ui-messages', 'auth-start', or 'auth-complete'" })),
      }),
      renderResult: renderMcpToolResult,
      async execute(_toolCallId, params: {
        tool?: string;
        args?: string;
        connect?: string;
        describe?: string;
        search?: string;
        regex?: boolean;
        includeSchemas?: boolean;
        server?: string;
        action?: string;
      }, _signal, _onUpdate, _ctx) {
        let parsedArgs: Record<string, unknown> | undefined;
        if (params.args) {
          try {
            parsedArgs = JSON.parse(params.args);
            if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
              const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
              throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
            }
            throw error;
          }
        }

        if (!state && initPromise) {
          try {
            state = await initPromise;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
              details: { error: "init_failed", message },
            };
          }
        }
        if (!state) {
          return {
            content: [{ type: "text" as const, text: "MCP not initialized" }],
            details: { error: "not_initialized" },
          };
        }

        if (params.action === "ui-messages") {
          return executeUiMessages(state);
        }
        if (params.action === "auth-start") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
              details: { mode: "auth-start", error: "missing_server" },
            };
          }
          return executeAuthStart(state, params.server);
        }
        if (params.action === "auth-complete") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires `server`." }],
              details: { mode: "auth-complete", error: "missing_server" },
            };
          }
          const input = parsedArgs?.redirectUrl ?? parsedArgs?.code ?? parsedArgs?.input;
          if (typeof input !== "string" || input.trim().length === 0) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires args with `redirectUrl`, `code`, or `input`." }],
              details: { mode: "auth-complete", error: "missing_input" },
            };
          }
          return executeAuthComplete(state, params.server, input);
        }
        if (params.tool) {
          return executeCall(state, params.tool, parsedArgs, params.server, getPiTools);
        }
        if (params.connect) {
          return executeConnect(state, params.connect);
        }
        if (params.describe) {
          return executeDescribe(state, params.describe);
        }
        if (params.search) {
          return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas);
        }
        if (params.server) {
          return executeList(state, params.server);
        }
        return executeStatus(state);
      },
    });
  }
}
