import { createServer } from 'https'
import fs from 'fs'
const caPath = ""
const serverCrtPath = ""
const serverKeyPath = ""

export function createHttpsProxy(auth: (req: any, res: any) => Promise<boolean> = async () => true){
    const server = createServer({
        ca: fs.readFileSync("./keys/ca.crt"),
        cert: fs.readFileSync("./keys/server.crt"),
        key: fs.readFileSync("./keys/server.key"),
        requestCert: false,
    },(req,res)=>{
        console.log(req.url);
        
        res.writeHead(200)
        res.end("Hello World")
    })
    return server
}
