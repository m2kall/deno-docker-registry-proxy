import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DOCKER_HUB = "https://registry-1.docker.io";
const AUTH_URL = "https://auth.docker.io/token";

serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  console.log(`请求: ${req.method} ${url.pathname}`);

  // 处理 CORS 预检请求
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

  // 根路径返回 HTML
  if (url.pathname === "/" || url.pathname === "") {
    return new Response(
      `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Docker Registry 代理</title>
      </head>
      <body>
        <h1>Docker Registry 代理</h1>
        <p>使用示例: <code>docker pull docker.pubhub.store/library/ubuntu:latest</code></p>
        <p>这是代理的欢迎页面。</p>
      </body>
      </html>
      `,
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  // 代理 /v2/* 到 Docker Hub
  if (url.pathname.startsWith("/v2/") || url.pathname === "/v2") {
    try {
      const upstreamUrl = new URL(`${DOCKER_HUB}${url.pathname}${url.search}`);
      console.log(`代理到: ${upstreamUrl}`);

      // 如果是 /v2/，检查认证需求
      if (url.pathname === "/v2" || url.pathname === "/v2/") {
        const response = await fetch(upstreamUrl, { method: req.method, headers: req.headers });
        const authHeader = response.headers.get("WWW-Authenticate");
        if (authHeader && response.status === 401) {
          // 动态生成 scope，支持任意公共镜像
          const scopeParts = url.pathname.split('/v2/')[1]?.split('/') || ['library', 'ubuntu'];
          const namespace = scopeParts[0] || 'library';
          const repository = scopeParts[1] || 'ubuntu';
          const scope = `repository:${namespace}/${repository}:pull`;
          console.log(`生成的 scope: ${scope}`);

          // 获取匿名 Token
          const tokenParams = new URLSearchParams({
            service: "registry.docker.io",
            scope,
          });
          const tokenResponse = await fetch(`${AUTH_URL}?${tokenParams}`);
          if (!tokenResponse.ok) {
            throw new Error(`Token 请求失败: ${tokenResponse.status} ${await tokenResponse.text()}`);
          }
          const tokenData = await tokenResponse.json();
          const token = tokenData.token;
          if (!token) {
            throw new Error("Token 未找到");
          }

          // 用 Token 重试
          const authReq = new Request(upstreamUrl, {
            method: req.method,
            headers: { ...Object.fromEntries(req.headers), "Authorization": `Bearer ${token}` },
          });
          const authResponse = await fetch(authReq);
          const newHeaders = new Headers(authResponse.headers);
          newHeaders.set("Access-Control-Allow-Origin", "*");
          return new Response(authResponse.body, {
            status: authResponse.status,
            headers: newHeaders,
          });
        }
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, {
          status: response.status,
          headers: newHeaders,
        });
      }

      // 其他 /v2/* 路径直接代理
      const proxyReq = new Request(upstreamUrl, {
        method: req.method,
        headers: req.headers,
      });
      const response = await fetch(proxyReq);

      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    } catch (error) {
      console.error("代理错误:", error.message);
      return new Response(
        JSON.stringify({ error: "代理错误", message: error.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  return new Response("未找到", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});
