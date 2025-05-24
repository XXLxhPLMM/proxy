import { Socket } from "net";

/**
 * 缓存 工具类
 */
export class CacheUtil {


}





/**
 * @class ProxyServer
 * @property { string } host
 */
class ProxyServer {
    host: string = "";
    port: number = -1;
    key: string = "";
    #socket: Socket | null = null;
    constructor(host: string, port: number, key: string) {
        this.host = host;
        this.port = port;
        this.key = key;
    }

    setSocket(socket: Socket): void {
        this.#socket = socket;
    }
}

class ProxyMap extends Map<string, ProxyServer> {
    constructor(){
        super();
    }
}