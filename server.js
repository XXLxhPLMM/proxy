const http = require("http");
const https = require("https");
const net = require("net");
// 代理服务器的地址和端口

// 创建一个 HTTP 代理服务器
const server = http.createServer((req, res) => {
  if (req.method === 'CONNECT') {
    console.log('Caught a CONNECT request');
  }
  // 构建代理请求
  const options = {
    hostname: req.headers.host,
    port: new URL(req.url).port, // 或者目标服务器的端口
    path: req.url,
    method: req.method,
    headers: req.headers,
  };
//   console.log(options.path.search("https://"));
  let proxyReq = undefined;
  console.log(req.url,req.headers);
  // 发送代理请求至目标服务器
  //   if (true) {
  //     proxyReq = https.request(options, (proxyRes) => {
  //       res.writeHead(proxyRes.statusCode, proxyRes.headers);
  //       proxyRes.pipe(res, {
  //         end: true,
  //       });
  //     });
  //     // 将客户端请求体发送至目标服务器
  //     req.pipe(proxyReq, {
  //       end: true,
  //     });
  //   } else {
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
  // console.log(parts);
  console.log(req.headers);
  const upstream = net.connect(
    parseInt(parts[1], 10),
    parts[0],
    () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }
  );
});

server.on('request',(r,res)=>{
  // res.end()
  console.log(r.method);
})

// 设置代理服务器监听的端口
const port = 444;
server.listen(port, () => {
  console.log(`Proxy Server running at http://localhost:${port}`);
});
