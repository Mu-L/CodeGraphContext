// website/api/v1/mcp/messages.ts
import { createClient } from "@supabase/supabase-js";

export default async function handler(req: any, res: any) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const message = req.body;
  if (!message || typeof message !== "object") {
    return res.status(400).json({ error: "Invalid JSON-RPC request." });
  }

  const { jsonrpc, method, id, params } = message;

  if (jsonrpc !== "2.0") {
    return res.status(400).json({
      jsonrpc: "2.0",
      id: id || null,
      error: { code: -32600, message: "Invalid Request: expected jsonrpc: '2.0'" }
    });
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "Server configuration error: Supabase credentials are missing on Vercel." }
    });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  try {
    switch (method) {
      case "initialize": {
        return res.status(200).json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: "CodeGraphContext-Dynamic-MCP",
              version: "1.0.0"
            }
          }
        });
      }

      case "notifications/initialized": {
        return res.status(200).end();
      }

      case "tools/list": {
        // Query the default tunnel channel for the tools manifest from the active browser tab
        // Use a default/global channel name for listing tools
        const channelName = "cgc-tunnel-global-mcp";
        const channel = supabase.channel(channelName);
        const requestId = Math.random().toString(36).substring(2, 15);
        let hasResponded = false;

        const cleanup = () => {
          try { supabase.removeChannel(channel); } catch (err) {}
        };

        const responsePromise = new Promise<any>((resolve, reject) => {
          channel
            .on(
              "broadcast",
              { event: "tools-list-response" },
              ({ payload }: { payload: any }) => {
                if (payload && payload.id === requestId) {
                  hasResponded = true;
                  cleanup();
                  resolve(payload);
                }
              }
            )
            .subscribe((status: string) => {
              if (status === "CLOSED" || status === "TIMED_OUT") {
                reject(new Error(`Subscription closed: ${status}`));
              }
            });
        });

        const sendStatus = await channel.send({
          type: "broadcast",
          event: "tools-list-request",
          payload: { id: requestId }
        });

        if (sendStatus !== "ok") {
          cleanup();
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [] // Fallback to empty if broadcast fails
            }
          });
        }

        const timeoutPromise = new Promise<any>((resolve) => {
          setTimeout(() => {
            if (!hasResponded) {
              cleanup();
              resolve({ status: "offline" });
            }
          }, 5000);
        });

        const listResult = await Promise.race([responsePromise, timeoutPromise]);

        if (listResult.status === "offline") {
          // Provide a fallback schema to Claude explaining how to connect
          const connectNoticeTool = {
            name: "cgc_connect_notice",
            description: "ALERT: Browser-as-a-Server dashboard is offline. Open https://codegraphcontext.vercel.app to activate full Python MCP tools.",
            inputSchema: { type: "object", properties: {} }
          };
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: { tools: [connectNoticeTool] }
          });
        }

        return res.status(200).json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: listResult.tools || []
          }
        });
      }

      case "tools/call": {
        const { name: toolName, arguments: toolArgs } = params || {};
        if (!toolName) {
          return res.status(400).json({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: name is required." }
          });
        }

        // Extract repo from arguments to direct to the correct browser channel
        const repo = toolArgs?.repo || toolArgs?.repository || "";
        if (!repo || typeof repo !== "string") {
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{
                type: "text",
                text: "Error: Missing required argument 'repo' (owner/repo) inside tool arguments. All remote tools require a target repository path."
              }]
            }
          });
        }

        const cleanRepo = repo.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//, "").replace(/\/$/, "");
        const cleanRepoName = cleanRepo.replace(/\//g, "_").toLowerCase();
        
        // Connect to the repository-specific channel
        const channelName = `cgc-tunnel-${cleanRepoName}`;
        const channel = supabase.channel(channelName);
        const requestId = Math.random().toString(36).substring(2, 15);
        let hasResponded = false;

        const cleanup = () => {
          try { supabase.removeChannel(channel); } catch (err) {}
        };

        const responsePromise = new Promise<any>((resolve, reject) => {
          channel
            .on(
              "broadcast",
              { event: "tool-call-response" },
              ({ payload }: { payload: any }) => {
                if (payload && payload.id === requestId) {
                  hasResponded = true;
                  cleanup();
                  resolve(payload);
                }
              }
            )
            .subscribe((status: string) => {
              if (status === "CLOSED" || status === "TIMED_OUT") {
                reject(new Error(`Subscription closed: ${status}`));
              }
            });
        });

        const sendStatus = await channel.send({
          type: "broadcast",
          event: "tool-call-request",
          payload: {
            id: requestId,
            toolName,
            args: toolArgs
          }
        });

        if (sendStatus !== "ok") {
          cleanup();
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Error: Failed to broadcast tool call over signaling channel: ${sendStatus}` }]
            }
          });
        }

        const timeoutPromise = new Promise<any>((resolve) => {
          setTimeout(() => {
            if (!hasResponded) {
              cleanup();
              resolve({ status: "offline" });
            }
          }, 8000);
        });

        const callResult = await Promise.race([responsePromise, timeoutPromise]);

        if (callResult.status === "offline") {
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{
                type: "text",
                text: `Error: The Browser-as-a-Server dashboard for '${cleanRepo}' is currently closed.\n\nTo enable Claude to run your Python tools, please open https://codegraphcontext.vercel.app in an active browser tab.`
              }]
            }
          });
        }

        if (callResult.status === "error") {
          return res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Python MCPServer Error: ${callResult.error}` }]
            }
          });
        }

        // Return the exact content structure returned by the Python MCP handler
        return res.status(200).json({
          jsonrpc: "2.0",
          id,
          result: callResult.result
        });
      }

      default: {
        return res.status(404).json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: '${method}'` }
        });
      }
    }

  } catch (error: any) {
    console.error("MCP handler error:", error);
    return res.status(500).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Internal server error: ${error.message}` }
    });
  }
}
