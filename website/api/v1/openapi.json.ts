// website/api/v1/openapi.json.ts
export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const host = req.headers.host || "codegraphcontext.vercel.app";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  const spec = {
    openapi: "3.0.0",
    info: {
      title: "CodeGraphContext Tunneling API",
      description: "Zero-server-compute API that tunnels semantic queries directly to Kuzu WASM running in the user's active browser tab. Queries classes, functions, calls, and file structural containment maps locally.",
      version: "1.0.0"
    },
    servers: [
      {
        url: baseUrl,
        description: "CodeGraphContext Production Server"
      }
    ],
    paths: {
      "/api/v1/query": {
        get: {
          summary: "Execute Tunneled Code Graph Query",
          description: "Tunnels queries directly to the client's browser Kuzu WASM graph database. Queries code structures, tracers, and definitions in real-time.",
          operationId: "querySemanticGraph",
          parameters: [
            {
              name: "repo",
              in: "query",
              description: "GitHub repository path in 'owner/repo' format (e.g. 'requests/requests').",
              required: true,
              schema: {
                type: "string"
              }
            },
            {
              name: "query_type",
              in: "query",
              description: "The semantic query lookup to perform.",
              required: true,
              schema: {
                type: "string",
                enum: ["definitions", "callers", "callees", "file_structure", "search", "cypher"]
              }
            },
            {
              name: "target",
              in: "query",
              description: "The name of the target symbol to find (required for 'definitions', 'callers', 'callees', 'search').",
              required: false,
              schema: {
                type: "string"
              }
            },
            {
              name: "cypher_query",
              in: "query",
              description: "Standard Cypher query string if 'query_type' is 'cypher'.",
              required: false,
              schema: {
                type: "string"
              }
            }
          ],
          responses: {
            "200": {
              description: "Query successfully executed in browser Kuzu WASM database",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      query_type: { type: "string" },
                      target: { type: "string" },
                      data: {
                        type: "array",
                        items: {
                          type: "object"
                        }
                      }
                    }
                  }
                }
              }
            },
            "412": {
              description: "Browser dashboard is offline/closed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      error: { type: "string" },
                      message: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  return res.status(200).json(spec);
}
