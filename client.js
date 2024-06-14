const http = require("http");
const https = require("https");
const net = require("net");
// 代理服务器的地址和端口

function proxy(){

}

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
  console.log(options);
  const proxyReq = http.request(options, (proxyRes) => {
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
  const proxyReq = http.request({
    host: '156.238.236.4',
    port: 444,
    method: req.method,
    path: req.url,
    headers: {
      'proxy-authorization':"aaaaa11",
      ...req.headers}
  });

  console.log(req.url);
  proxyReq.on('connect', (proxyRes, proxySocket, proxyHead) => {
    // 将代理服务器的响应转发给客户端
    clientSocket.pipe(proxySocket);
    proxySocket.pipe(clientSocket);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
      '\r\n');
    proxySocket.write(head);
    
  });

  proxyReq.on('error', (e) => {
    console.error('Proxy 2 error:', e);
    clientSocket.end();
  });

  // 结束第二个代理服务器的请求
  proxyReq.end();
});

server.on('error',(e)=>{
  console.log('服务出错',e);
})

// 设置代理服务器监听的端口
const port = 443;
server.listen(port, () => {
  console.log(`Proxy Server running at http://localhost:${port}`);
});


process.on('uncaughtException', (error) => {
  // start()
  console.error('Uncaught Exception:', error);
  // 可以在这里进行日志记录或其他处理
  // process.exit(1); // 退出进程，避免应用程序继续执行
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // start()
  // 可以在这里进行日志记录或其他处理
});