const https = require("https");
const http = require('http')
const net = require("net");
const fs = require('fs')
/**
 * @type { https.Server }
 */
let server = null

function run() {
  // 创建一个 HTTP 代理服务器
  console.log('启动服务中');
  server = https.createServer({
    cert: fs.readFileSync('server.cert'),
    key:fs.readFileSync('server.key')
  },(req, res) => {

    // 构建代理请求
    const options = {
      hostname: req.headers.host,
      port: new URL(req.url).port, // 或者目标服务器的端口
      path: req.url,
      method: req.method,
      headers: req.headers,
    };

    console.log(req.url, req.headers);
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


    // 处理代理请求错误
    proxyReq.on("error", (err) => {
      console.error(err);
      res.statusCode = 500;
      res.end("Proxy request failed");
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    try {
      const parts = req.url.split(":");

      // delete req.headers["proxy-authorization"]
      req.headers["proxy-authorization"] = "true"
      console.log(parts);
      // ------------------------- 鉴权 --------------------------
      // if (req.headers["proxy-authorization"]) {
      // console.log('关闭状态', clientSocket.closed);
      const upstream = net.connect(
        parseInt(parts[1], 10),
        parts[0],
        () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
          // console.log(new TextDecoder("utf-8").decode(head));
        }
      );


      // upstream.on('close', () => {
      //   console.log('关闭');
      // })
      upstream.on('error', (e) => {
        console.log('socket err:', e.message);
        //  ---------------- 日志记录 -------------------
      })

      // upstream.on('data',(data)=>{
      //   //  ---------------- 拦截数据 -------------------
      //   // console.log();
      // })

      // 链接双方管道

      // return
      // }
      // else {
      //   clientSocket.destroy()
      //   return
      // }

    } catch {

    }
  });

  server.on('error', (e) => {
    console.log('http 服务出错:', e);
    //  ---------------- 日志记录 -------------------
  })

  // 设置代理服务器监听的端口
  const port = 444;
  server.listen(port, () => {
    console.log(`Proxy Server running at http://localhost:${port}`);
  });
}

function loopRun() {
  return new Promise((res, rej) => {
    try {
      run()
      // console.log('');
    } catch {
      res()
    }
  })
}

let count = -1
let use = 0;
const start = async () => {
  while (true) {
    use++
    if (count > 0 && use < count) {
      await loopRun()
    } else if (count <= 0) {
      await loopRun()
    }
    else {
      break
    }
  }
  console.log('服务结束');
}
start()
process.on('uncaughtException', (error) => {
  console.error('Node异常出错', error.message);
  // if(server){
  //   server.
  // }else{
  //   start()
  // }
  // 可以在这里进行日志记录或其他处理
  // process.exit(1); // 退出进程，避免应用程序继续执行
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('服务器异常出错 promise');
  // 可以在这里进行日志记录或其他处理
});
