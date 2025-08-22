import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DOCKER_HUB = "https://registry-1.docker.io";

serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  console.log(`Request: ${req.method} ${url.pathname}`);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Root path: serve landing page
  if (url.pathname === "/" || url.pathname === "") {
    return new Response(
      `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Docker Registry Proxy</title>
      </head>
      <body>
        <h1>Docker Registry Proxy</h1>
        <p>This is a proxy for Docker Hub. </p>
      </body>
      </html>
      `,
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  // Proxy /v2/* to Docker Hub
  if (url.pathname.startsWith("/v2/") || url.pathname === "/v2") {
    try {
      const upstreamUrl = new URL(`${DOCKER_HUB}${url.pathname}${url.search}`);
      console.log(`Proxying to: ${upstreamUrl}`);
      const proxyReq = new Request(upstreamUrl, {
        method: req.method,
        headers: req.headers,
      });
      const response = await fetch(proxyReq);
      
      // Copy response with CORS headers
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    } catch (error) {
      console.error("Proxy error:", error.message);
      return new Response(
        JSON.stringify({ error: "Proxy Error", message: error.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  // Fallback for unmatched paths
  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
});
