// website/api/v1/query.ts
import { createClient } from "@supabase/supabase-js";

export default async function handler(req: any, res: any) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const method = req.method;
  const params = method === "POST" ? (req.body || {}) : (req.query || {});
  const { repo, query_type, target, cypher_query } = params;

  if (!repo || typeof repo !== "string") {
    return res.status(400).json({ error: "Missing required parameter 'repo' (owner/repo)." });
  }

  if (!query_type || typeof query_type !== "string") {
    return res.status(400).json({ 
      error: "Missing required parameter 'query_type'. Expected: 'definitions', 'callers', 'callees', 'file_structure', or 'cypher'." 
    });
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({
      error: "Server configuration error: Supabase credentials are not configured on Vercel."
    });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const cleanRepo = repo.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//, "").replace(/\/$/, "");
  
  // Clean channel name matches the specific repo to segment traffic
  const cleanRepoName = cleanRepo.replace(/\//g, "_").toLowerCase();
  const channelName = `cgc-tunnel-${cleanRepoName}`;
  const channel = supabase.channel(channelName);

  const requestId = Math.random().toString(36).substring(2, 15);
  let hasResponded = false;

  // Cleanup helper
  const cleanup = () => {
    try {
      supabase.removeChannel(channel);
    } catch (err) {}
  };

  try {
    // 1. Subscribe to the response channel first
    await new Promise<void>((resolve, reject) => {
      channel
        .on(
          "broadcast",
          { event: "query-response" },
          ({ payload }: { payload: any }) => {
            if (payload && payload.id === requestId) {
              hasResponded = true;
              cleanup();

              if (payload.status === "success") {
                return res.status(200).json(payload.result);
              } else {
                return res.status(500).json({
                  error: "Query execution failed inside client Kuzu WASM database.",
                  details: payload.error
                });
              }
            }
          }
        )
        .subscribe((status: string) => {
          if (status === "SUBSCRIBED") {
            resolve();
          } else if (status === "CLOSED" || status === "TIMED_OUT") {
            reject(new Error(`Failed to subscribe to tunnel channel: ${status}`));
          }
        });
    });

    // 2. Dispatch query-request to the active browser tab
    const sendStatus = await channel.send({
      type: "broadcast",
      event: "query-request",
      payload: {
        id: requestId,
        queryType: query_type,
        target: target || cypher_query || "",
        params: {
          cypher_query,
          repo: cleanRepo
        }
      }
    });

    if (sendStatus !== "ok") {
      cleanup();
      return res.status(502).json({
        error: "Failed to broadcast query to the signaling tunnel.",
        details: sendStatus
      });
    }

    // 3. Set a strict wait-timeout (e.g. 6 seconds) for client-side WASM execution
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!hasResponded) {
          cleanup();
          res.status(412).json({
            status: "offline",
            error: "Browser-as-a-Server dashboard is currently offline or closed.",
            message: `To allow your AI assistant to query the graph of ${cleanRepo}, please keep https://codegraphcontext.vercel.app open in an active browser tab. Kuzu WASM will automatically boot locally and process your requests instantly.`
          });
        }
        resolve();
      }, 6000);
    });

  } catch (error: any) {
    cleanup();
    console.error("Signaling tunnel query error:", error);
    return res.status(500).json({
      error: "Signaling gateway failed to execute tunnel query.",
      details: error.message
    });
  }
}
