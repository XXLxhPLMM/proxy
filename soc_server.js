const net = require('net')
const http = require('http')


const server = new net.Server((client)=>{
    client.on('data',(data)=>{
        console.log('客户端数据',data.toString('utf-8'));
        http.request({
            host:'www.google.com',
            port:80,
            
        },(res)=>{
            let data = '';
        
            // 接收响应数据
            res.on('data', (chunk) => {
                data += chunk;
            });
        
            // 响应结束，处理数据
            res.on('end', () => {
                client.write(data)
                console.log(data); // 输出完整的响应数据
            });
        }).end()
    })
})

const PROT = 8888

server.listen(PROT,()=>{
    console.warn(`服务已经启动在${PROT}`);
})


