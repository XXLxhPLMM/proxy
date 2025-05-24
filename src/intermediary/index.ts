import koa from "koa";
import { getLogger } from "@/utils/log";
import { ConfigMap } from "@/config/load";
import http from "http";
import https from "https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { secrtMap } from "@/client";
import { unzipSync, gunzipSync, inflateSync } from "zlib";
const INTERMEDIARY_LOG = getLogger("intermediary");
const PORT = () => ConfigMap.intermediary_port;
/**
 * 代理信息
 */
interface ProxyInfo {
    auth: string,
    auth_type: "jwt" | "string" | "basic" | "pwd",
    url: string
}

/**
 * 代理对象
 */
interface ProxyRequest {
    url: string;
    headers: Record<string, string>;
    method: string;
    data: string;
    port: number;
    params: Record<string, string>;
    proxy: ProxyInfo;
}
/**
 * 压缩处理映射
 */
const compressMap = {
    "gzip": (data: Buffer) => gunzipSync(data),
    "deflate": (data: Buffer) => inflateSync(data),
    "zip": (data: Buffer) => unzipSync(data),
    "identity": (data: Buffer) => data,
};
/**
 * 请求处理函数
 * @param ctx koa.Context
 * @returns 
 */
function getProxyRequest(ctx: koa.Context): Promise<ProxyRequest> {
    return new Promise((res, rej) => {
        const cs: Buffer[] = [];
        ctx.req.on("data", (chunk: Buffer) => {
            cs.push(chunk);
        });
        ctx.req.on("end", () => {
            // 解析 json 请求
            const data = Buffer.concat(cs).toString();
            try {
                res(JSON.parse(data));
            } catch {
                res(data as any);
            }
        });
        ctx.req.on("error", (err) => {
            rej(err);
        });
    });
}

function sendProxy(req: typeof http.request | typeof https.request, Agent: typeof HttpProxyAgent | typeof HttpsProxyAgent, d: ProxyRequest): Promise<string> {
    return new Promise((res, rej) => {
        // 建立请求
        const r = req!(d.url, {
            headers: d.headers,
            method: d.method,
            port: d.port,
            agent: new Agent(d.proxy.url, {
                headers: {
                    Host: "",
                    "Proxy-Connection": "keep-alive",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
                    "Proxy-Authorization": secrtMap[d.proxy.auth_type](d.proxy.auth),
                },
            },
            ),
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
                INTERMEDIARY_LOG.debug(`接收到服务器数据块 ${chunk.length}`);
            });
            response.on("end", () => {
                INTERMEDIARY_LOG.debug("数据接收完成");
                let data = Buffer.concat(chunks);
                // 解析 字符集
                const contentType = response.headers["content-type"] as string;
                // 处理 压缩格式
                const encoding = response.headers["content-encoding"] as keyof typeof compressMap;
                if (ConfigMap.handle_compress && encoding && compressMap[encoding]) {
                    data = compressMap[encoding](data);
                }
                const setArr = /charset=(\S+)/.exec(contentType || "charset=utf-8");
                const charset = setArr && setArr.length > 1 ? setArr![1] : "utf-8";
                // 构建响应
                const result = {
                    headers: response.headers,
                    message: response.statusMessage,
                    httpVersion: response.httpVersion,
                    statusCode: response.statusCode,
                    data: data.toString(charset as BufferEncoding),
                };
                res(JSON.stringify(result));
            });
            response.on("error", (err) => {
                rej(err);
            });
        });
        // 转换为字符
        if (d.data) {
            let body = d.data;
            if(d.headers["Content-Type"] && d.headers["Content-Type"].includes("json")){
                body = JSON.stringify(d.data);
            }
            r.setHeader("Content-Length", Buffer.byteLength(body));
            r.write(body, () => {
                r.end();
            });
        } else {
            r.end();
        }
        r.on("error", (err) => {
            rej(err);
        });
    });
}

export function runIntermediary() {
    const app = new koa();
    app.use(async (ctx, next) => {
        // 解析请求 获取关于代理的数据 
        const d: ProxyRequest = await getProxyRequest(ctx);
        INTERMEDIARY_LOG.debug("客户端请求参数", d);
        //  根据 请求类型的不同获取不同的 实现类
        let req: typeof http.request | typeof https.request | undefined = undefined;
        let Agent: typeof HttpProxyAgent | typeof HttpsProxyAgent | undefined = undefined;
        if (d.url.startsWith("http://")) {
            req = http.request;
            Agent = HttpProxyAgent;
        } else if (d.url.startsWith("https://")) {
            req = https.request;
            Agent = HttpsProxyAgent;
        }
        INTERMEDIARY_LOG.debug("向服务器发送数据");
        // 代理发送请求
        const data = await sendProxy(req!, Agent!, d);
        INTERMEDIARY_LOG.debug("服务器数据", data);
        ctx.response.headers["content-type"] = "application/json; charset=UTF-8";
        ctx.body = data;
        next();
    });
    app.on("close", () => {
        INTERMEDIARY_LOG.info("服务器 关闭");
    });
    app.on("error", (err) => {
        INTERMEDIARY_LOG.info("服务器 出错");
        INTERMEDIARY_LOG.debug(err);
    });
    app.listen(PORT(), () => {
        INTERMEDIARY_LOG.info(`Intermediary server is running on port ${PORT()}`);
    });
    return app;
}
