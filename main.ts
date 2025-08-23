import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DOCKER_HUB = "https://registry-1.docker.io";
const AUTH_URL = "https://auth.docker.io/token";

// 全局变量支持 XLSX 处理
let gk_isXlsx = true;
let gk_xlsxFileLookup: { [key: string]: boolean } = {};
let gk_fileData: { [key: string]: string } = {};

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
        <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
      </head>
      <body>
        <h1>Docker Registry 代理</h1>
        <p>使用示例: <code>docker pull docker.pubhub.store/library/ubuntu:latest</code></p>
        <p>这是静态兜底页面，支持 XLSX 文件处理。</p>
        <form action="/upload" method="post" enctype="multipart/form-data">
          <input type="file" name="file" accept=".xlsx">
          <button type="submit">上传 XLSX 文件</button>
        </form>
        <script type="text/javascript">
          var gk_isXlsx = true;
          var gk_xlsxFileLookup = {};
          var gk_fileData = {};
          function filledCell(cell) {
            return cell !== '' && cell != null;
          }
          function loadFileData(filename) {
            if (gk_isXlsx && gk_xlsxFileLookup[filename]) {
              try {
                var workbook = XLSX.read(gk_fileData[filename], { type: 'base64' });
                var firstSheetName = workbook.SheetNames[0];
                var worksheet = workbook.Sheets[firstSheetName];
                var jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false, defval: '' });
                var filteredData = jsonData.filter(row => row.some(filledCell));
                var headerRowIndex = filteredData.findIndex((row, index) =>
                  row.filter(filledCell).length >= filteredData[index + 1]?.filter(filledCell).length
                );
                if (headerRowIndex === -1 || headerRowIndex > 25) headerRowIndex = 0;
                var csv = XLSX.utils.aoa_to_sheet(filteredData.slice(headerRowIndex));
                return XLSX.utils.sheet_to_csv(csv, { header: 1 });
              } catch (e) {
                console.error(e);
                return "";
              }
            }
            return gk_fileData[filename] || "";
          }
        </script>
      </body>
      </html>
      `,
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  // 处理 XLSX 文件上传
  if (url.pathname === "/upload" && req.method === "POST") {
    const formData = await req.formData();
    const file = formData.get("file");
    if (file instanceof File) {
      const data = await file.arrayBuffer();
      gk_fileData[file.name] = btoa(String.fromCharCode(...new Uint8Array(data)));
      gk_xlsxFileLookup[file.name] = true;
      return new Response(JSON.stringify({ message: "文件上传成功" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("无效文件", { status: 400 });
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
