// import { encryptText,decryptText,encryptionKey,iv } from "./src/utils/crypt.js";

// let d = ""
// for(let i =0 ;i<1000;i++){
//     d += 'AbcdeA'
// }

// let data= encryptText(d,encryptionKey,iv)
// console.log(data);
// data = decryptText(data,encryptionKey,iv)
// console.log(data.toString());

import net from 'net';
net.connect({port:80,host:'www.baidu.com'},()=>{
    console.log('connected')
})