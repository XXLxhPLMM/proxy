
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
    host: string = '';
    port: number = -1;
    key: string = '';
    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
    }
}