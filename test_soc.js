const net = require('net');

// 创建一个 TCP 服务器
const server = net.createServer((socket) => {
    // 新的连接建立时触发
    console.log('客户端已连接');

    // 接收客户端发送的数据
    socket.on('data', (data) => {
        console.log(`接收到客户端的数据: ${data}`);
        // 回复客户端
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.write("{asdfas}")
        // socket.end()
    });


    // 监听客户端断开连接
    socket.on('end', () => {
        console.log('客户端已断开连接');
    });

    // 处理错误事件
    socket.on('error', (err) => {
        console.error('socket error:', err);
    });
});

// 监听指定的端口和 IP
const PORT = 3000;
const HOST = '127.0.0.1';
server.listen(PORT, HOST, () => {
    console.log(`服务器正在监听 ${HOST}:${PORT}`);
});