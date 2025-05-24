import { Transform } from "stream";
import net from "net";
import tls from "tls";
import { HTTPParser } from "http-parser-js";
import { ConfigMap } from "@/config/load";
import { getFile } from "./file-util";
export class ClientTransform extends Transform {
    async _transform(chunk: Buffer, encoding: string, callback: (err?: any, data?: any) => void) {
        console.log("客户端数据", chunk);
        callback(null, chunk);
    }
}

export class ServerTransform extends Transform {
    _transform(chunk: Buffer, encoding: string, callback: (err?: any, data?: any) => void) {
        console.log("服务端数据", chunk);
        callback(null, chunk);
    }
}

/**
* 目标连接器 加鉴权
*/
export class ClientConnectTransform extends Transform {
    #token: string = "";
    #host: string = "";
    #port: number = 0;
    #socket: net.Socket | null = null;
    #isConnect: boolean = false;
    constructor(token: string, host: string, port: number) {
        super();
        // 初始化连接
        this.#token = token;
        this.#host = host;
        this.#port = port;
        this.#connect();
    }
    async _transform(chunk: Buffer, encoding: string, callback: (err?: any, data?: any) => void) {
        try {
            if (ConfigMap.use_auth && !this.#isConnect) {
                const parser = new HTTPParser(HTTPParser.REQUEST);
                let data = chunk;
                parser.onHeadersComplete = (info) => {
                    // console.log("原始\n" + data.toString());
                    const line = chunk.buffer.slice(0, chunk.indexOf("\r\n\r\n"));
                    const content = chunk.buffer.slice(chunk.indexOf("\r\n\r\n"));
                    const token = `\r\nProxy-Authorization: ${this.#token}`;
                    data = Buffer.concat([Buffer.from(line), Buffer.from(token), Buffer.from(content)]);
                    this.#isConnect = true;
                    // console.log("line\n" + Buffer.from(line).toString());
                    // console.log("content\n" +  Buffer.from(content).toString());
                    // console.log("data\n" + data.toString());
                };
                parser.execute(data);
                callback(null, data);
            } else {
                callback(null, chunk);
            }
        } catch (err) {
            callback(err);
        }
    }
    changeTarget(host: string, port: number) {
        this.#host = host;
        this.#port = port;
        this.#connect();
    }
    /**
     * 改变token
     */
    changeToken(token: string) {
        this.#token = token;
    }
    /**
     * 设置socket
     */
    setSocket(socket: net.Socket) {
        this.#socket = socket;
    }
    /**
     * 连接函数
     */
    #connect() {
        if (this.#socket) {
            this.#socket.destroy();
        }
        if (ConfigMap.target_type === "https" || ConfigMap.target_type === "tls") {
            this.#socket = tls.connect({
                host: this.#host,
                port: this.#port,
                ca: getFile(ConfigMap.s_ca_cert),
                cert: getFile(ConfigMap.s_client_cert),
                key: getFile(ConfigMap.s_client_key),
                passphrase: ConfigMap.s_client_password,
                requestCert: ConfigMap.app_bothway_auth,
                rejectUnauthorized: ConfigMap.app_auth_cert,
            }, () => { });
        } else {
            // 连接目标服务器
            this.#socket = net.connect(this.#port, this.#host, () => { });
        }

        this.#socket.on("error", (err) => {
            this.emit("error", err);
        });
        this.#socket.on("close", () => {
            this.emit("close");
        });
        this.pipe(this.#socket);
    }
    getSocket() {
        return this.#socket!;
    }
}

// export class VerifyTransform extends Transform {
//     _transform(chunk: Buffer, encoding: string, callback: (err?: any, data?: any) => void) {

//     }
// }