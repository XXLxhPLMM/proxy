import { createServer } from 'tls'
export function createTlsProxyServer(auth: (req: any, res: any) => Promise<boolean> = async () => true) {
    const server = createServer({

    })
    return server
}