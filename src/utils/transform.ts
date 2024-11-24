import { Transform } from 'stream'
import net from 'net'
import { HTTPParser } from 'http-parser-js'
export class ClientTransform extends Transform {
    async _transform(chunk: Buffer, encoding: string, callback: (err?: any, data?: any) => void) {
        console.log('客户端数据', chunk)
        callback(null, chunk)
    }
}

export class ServerTransform extends Transform {
    _transform(chunk: Buffer, encoding: string, callback: (err?: any, data?: any) => void) {
        console.log('服务端数据', chunk)
        callback(null, chunk)
    }
}

export /**
* 目标连接器 加鉴权
*/
    class ClientConnectTransform extends Transform {
    #token: string = ""
    #host: string = ""
    #port: number = 0
    #socket: net.Socket | null = null
    constructor(token: string, host: string, port: number) {
        super()
        this.#token = token
        this.#host = host
        this.#port = port
        this.#connect()
    }
    async _transform(chunk: Buffer, encoding: string, callback: (err?: any, data?: any) => void) {
        try {
            if (process.env.APP_USE_AUTH === "true") {
                const parser = new HTTPParser(HTTPParser.REQUEST)
                let data = chunk
                parser.onHeadersComplete = (info) => {
                    const line = chunk.buffer.slice(0, chunk.indexOf("\r\n"))
                    const content = chunk.buffer.slice(chunk.indexOf("\r\n"))
                    const token = `\r\nProxy-Authorization: ${this.#token}`
                    data = Buffer.concat([Buffer.from(line), Buffer.from(token), Buffer.from(content)])
                }
                parser.execute(data)
                callback(null, data)
            } else {
                callback(null, chunk)
            }
        } catch (err) {
            callback(err)
        }
    }
    changeTarget(host: string, port: number) {
        this.#host = host
        this.#port = port
        this.#connect()
    }
    changeToken(token: string) {
        this.#token = token
    }
    setSocket(socket: net.Socket) {
        this.#socket = socket
    }
    #connect() {
        if (this.#socket) {
            this.#socket.destroy()
        }
        this.#socket = net.connect(this.#port, this.#host, () => { })
        this.#socket.on('error', (err) => {
            this.emit('error', err)
        })
        this.#socket.on('close', () => {
            this.emit('close')
        })
        this.pipe(this.#socket)
    }
    getSocket() {
        return this.#socket!
    }
}