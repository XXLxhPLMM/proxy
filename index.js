const http = require("http");
const https = require("https");
const net = require("net");
// 代理服务器的地址和端口

// 创建一个 HTTP 代理服务器
const server = http.createServer((req, res) => {
  // 构建代理请求
  const options = {
    hostname: req.headers.host,
    port: new URL(req.url).port, // 或者目标服务器的端口
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  let proxyReq = undefined;
  proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, {
      end: true,
    });
  });
  // 将客户端请求体发送至目标服务器
  req.pipe(proxyReq, {
    end: true,
  });
  //   }

  // 处理代理请求错误
  proxyReq.on("error", (err) => {
    console.error(err);
    res.statusCode = 500;
    res.end("Proxy request failed");
  });
});

server.on("connect", (req, clientSocket, head) => {
  const parts = req.url.split(":");
  console.log(parts);
  // const option = {
  //   hostname: parts[0],
  //   port: parts[1], // 或者目标服务器的端口
  //   path: req.url,
  //   method: req.method,
  //   headers: req.headers,
  // }
  // clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  // let p = http.request(option, (res) => {
  //   // clientSocket.write(head)
  //   res.pipe(clientSocket,{
  //     end: true,
  //   })
  // })
  // clientSocket.pipe(p,{
  //   end: true,
  // });
  // p.on('error', (e) => {
  //   console.log('socket 链接错误', e.message);
  // })

  const upstream = net.createConnection(
    parseInt(parts[1], 10),
    parts[0],
    () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }
  );
  upstream.on('error', (e) => {
    console.log('socket 链接错误',e.message);
  })
});
server.on('error', (e) => {
  console.log('http 服务出错', e);
})

// 设置代理服务器监听的端口
const port = 443;
server.listen(port, () => {
  console.log(`Proxy Server running at http://localhost:${port}`);
});
