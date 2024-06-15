const net = require('net');

// 代理服务器的配置
const proxyPort = 444; // 代理服务器监听的端口号

// 创建一个 TCP 服务器
const server = net.createServer((clientSocket) => {
    console.log('客户端已连接');

    // 监听客户端发来的数据（HTTP 请求）
    clientSocket.once('data', (data) => {
        // 解析客户端发来的 HTTP 请求头
        const requestData = data.toString('utf-8');
        const reqL = requestData.split('\r\n')[0].split(' ')
        const method = reqL[0]
        const target = reqL[1]

        // 解析目标服务器的主机名和端口号

        let serverHostname = ''

        let serverPort = 80
        if (method != 'connect' && method != 'CONNECT') {
            const url = new URL(target)
            serverHostname = url.hostname;
            serverPort = url.port || 80
            // console.log(url);
        } else {
            serverHostname = target.split(':')[0]
            serverPort = target.split(':')[1] || 443
        }
        console.log('请求方法:', method);
        console.log('请求目标:', target);
        console.log('请求端口:', serverPort);
        // return
        // 创建一个与目标服务器的 TCP 连接
        const serverSocket = net.connect({ host: serverHostname, port: serverPort }, () => {
            console.log('已连接到目标服务器');
            // 如果是 CONNECT 方法，向客户端发送确认
            if (method === 'CONNECT' || method === 'connect') {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                
                // clientSocket.on()
                // serverSocket.write(data)
                clientSocket.pipe(serverSocket)
            } else {

                // 向目标服务器发送客户端的请求数据
                serverSocket.write(data);
            }
        });
        // serverSocket.pipe(clientSocket)
        // 监听目标服务器的响应数据，并转发给客户端

        serverSocket.on('data', (serverData) => {
            console.log('数据\n', serverData.toString());
            if (clientSocket.writableEnded) {
                console.log('传输结束');
            } else {
                clientSocket.write(serverData);
            }
        });

        // 监听目标服务器断开连接事件
        serverSocket.on('end', () => {
            console.log('与目标服务器断开连接');
            clientSocket.end();
        });

        // 监听目标服务器连接错误
        serverSocket.on('error', (err) => {
            console.error('目标服务器连接错误:', err);
            clientSocket.end();
        });

        // 监听客户端断开连接事件
        clientSocket.on('end', () => {
            console.log('客户端断开连接');
            serverSocket.end();
        });

        // 监听客户端连接错误
        clientSocket.on('error', (err) => {
            console.error('客户端连接错误:', err);
            serverSocket.end();
        });
    });

});

// 监听代理服务器的错误事件
server.on('error', (err) => {
    console.error('代理服务器发生错误:', err);
});

// 监听代理服务器的端口，并开始接受客户端连接
server.listen(proxyPort, () => {
    console.log(`代理服务器已启动，监听端口 ${proxyPort}`);
});